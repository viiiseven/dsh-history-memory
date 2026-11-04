import { randomUUID } from 'node:crypto';
import { MEMORY_INSTRUCTION } from './memory-prompts.js';

function failure(code) { return Object.assign(new Error('记忆摘要生成失败'), { code }); }

export function hostSummarizer(ctx, runtime) {
  const selection = () => {
    const preferred = ctx.get('agentDefaultModel')?.currentSelection?.();
    const target = runtime.memory.record?.modelSelection || runtime.memory.lastTarget || preferred;
    return target?.provider && target?.model ? target : null;
  };
  return {
    selection,
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
    async generate({ previous, chunks, maxChars, targetChars = maxChars, compact = false, maxTokens = runtime.config.memoryMaxTokens, target = selection(), signal }) {
      if (!target) throw failure('NO_SUMMARY_MODEL');
      const blocks = new Map(); let finish;
      const message = text => ({ id: randomUUID(), role: 'user', source: { kind: 'history-rag-summary' }, content: [{ type: 'text', text }] });
      const lengthInstruction = compact
        ? `上一版输出超长。请重写一份 ${targetChars} 字符以内的精简摘要。合并重复事实，省略过时细节和过程，优先保留手动修订、长期偏好、当前决定和待办。`
        : `摘要正文以 ${targetChars} 字符以内为目标，硬上限 ${maxChars} 字符。空间不足时合并已有内容，避免逐条追加原文。`;
      const stream = ctx.llm.stream({ provider: target.provider, model: target.model, maxTokens, signal,
        // This auxiliary call has no session tool history. An empty array is not
        // a valid ToolHistory ({ tools, updates }) and breaks addition-only routes.
        purpose: 'history-rag-summary', tools: [],
        system: `${MEMORY_INSTRUCTION}\n${lengthInstruction}`,
        messages: [message(JSON.stringify({ previous: { text: previous.text, source: previous.source, updatedAt: previous.updatedAt },
          additions: chunks.map(c => ({ session: c.session_id, seq: c.seq, part: c.part, role: c.role, time: c.time, cwd: c.cwd, text: c.text })) }))],
      });
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) || '') + chunk.text);
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.set(chunk.index, chunk.block.text);
        else if (chunk.type === 'finish') finish = chunk.reason;
        if ([...blocks.values()].reduce((n, text) => n + text.length, 0) > maxChars * 2) throw failure('SUMMARY_TOO_LONG');
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
