import { randomUUID } from 'node:crypto';
import { MEMORY_INSTRUCTION, MEMORY_COMPACT_INSTRUCTION } from './memory-prompts.js';

function failure(code) { return Object.assign(new Error('记忆摘要生成失败'), { code }); }

export function summaryInput({ previous, batch = { additions: [], context: [] }, phase = 'update', maxChars }) {
  return {
    system: `${phase === 'compact' ? MEMORY_COMPACT_INSTRUCTION : MEMORY_INSTRUCTION}\n合并后的记忆正文以 ${Math.floor(maxChars * 0.75)} 字符为目标，容量上限 ${maxChars} 字符。变更 JSON 的长度与正文容量分别计算。`,
    payload: { entries: (previous.entries || []).map(({ id, text, locked, protectedAt, sources }) => ({ id, text, locked, protectedAt,
      lastSourceTime: Math.max(0, ...(sources || []).map(source => source.time || 0)) })), context: batch.context, additions: batch.additions },
  };
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

export function hostSummarizer(ctx, runtime) {
  const contexts = new Map();
  const selection = () => {
    const preferred = ctx.get('agentDefaultModel')?.currentSelection?.();
    const target = runtime.memory.record?.modelSelection || runtime.memory.lastTarget || preferred;
    return target?.provider && target?.model ? target : null;
  };
  return {
    selection,
    async contextWindow(target, signal) {
      if (typeof ctx.llm.resolveModelInfo !== 'function') return null;
      const key = JSON.stringify(target), cached = contexts.get(key);
      if (cached && Date.now() - cached.time < 600000) return cached.value;
      const combined = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(failure('ABORTED'));
        combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort();
      });
      try {
        const info = await Promise.race([ctx.llm.resolveModelInfo(target.provider, target.model, combined), cancelled]);
        const value = info.context?.contextWindow || null; contexts.set(key, { time: Date.now(), value }); return value;
      } finally { combined.removeEventListener('abort', abort); }
    },
    hasProvider: provider => ctx.llm.listProviders().some(item => item.id === provider),
    async models() {
      const providers = ctx.llm.listProviders();
      const results = await Promise.allSettled(providers.map(async provider => ({ id: provider.id, name: provider.name || provider.id,
        models: (await ctx.llm.listModels(provider.id)).filter(m => !m.inputModalities || m.inputModalities.includes('text'))
          .map(m => ({ id: m.id, name: m.name || m.id })) })));
      const value = results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: providers[i].id, name: providers[i].name || providers[i].id, models: [], unavailable: true });
      // Some native adapters accept configured aliases but do not expose a catalog.
      for (const target of [selection(), runtime.memory.lastTarget, ctx.get('agentDefaultModel')?.currentSelection?.()]) {
        const provider = value.find(p => p.id === target?.provider);
        if (provider && !provider.models.some(m => m.id === target.model)) provider.models.push({ id: target.model, name: target.model });
      }
      return { providers: value, current: selection() };
    },
    async generate({ previous, batch, phase = 'update', maxChars, maxTokens = runtime.config.memoryMaxTokens, target = selection(), signal, onUsage }) {
      if (!target) throw failure('NO_SUMMARY_MODEL');
      const blocks = new Map(); let finish;
      const message = text => ({ id: randomUUID(), role: 'user', source: { kind: 'history-rag-summary' }, content: [{ type: 'text', text }] });
      const input = summaryInput({ previous, batch, phase, maxChars });
      const stream = ctx.llm.stream({ provider: target.provider, model: target.model, maxTokens, signal,
        // This auxiliary call has no session tool history. An empty array is not
        // a valid ToolHistory ({ tools, updates }) and breaks addition-only routes.
        purpose: 'history-rag-summary', tools: [],
        system: input.system, messages: [message(JSON.stringify(input.payload))],
      });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) || '') + chunk.text);
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.set(chunk.index, chunk.block.text);
        else if (chunk.type === 'finish') finish = chunk.reason;
        else if (chunk.type === 'usage') onUsage?.(normalizeUsage(chunk.usage));
        if ([...blocks.values()].reduce((n, text) => n + text.length, 0) > Math.max(16384, maxChars * 4)) throw failure('SUMMARY_RESPONSE_TOO_LARGE');
      }
      signal.throwIfAborted();
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        const error = failure(finish.failure?.code || (finish.kind === 'aborted' ? 'ABORTED' : 'SUMMARY_FAILED'));
        error.status = finish.failure?.status;
        throw error;
      }
      if (finish?.kind !== 'stop') throw failure(finish?.kind === 'max-tokens' ? 'SUMMARY_TRUNCATED' : 'SUMMARY_FAILED');
      return [...blocks.values()].join('\n').trim();
    },
  };
}
