import { randomUUID } from 'node:crypto';
import { MEMORY_INSTRUCTION } from './memory-prompts.js';

function failure(code) { return Object.assign(new Error('记忆摘要生成失败'), { code }); }

export function hostSummarizer(ctx, runtime) {
  const selection = () => {
    const preferred = ctx.get('agentDefaultModel')?.currentSelection?.();
    const target = preferred?.provider && preferred?.model ? preferred : runtime.memory.lastTarget;
    return target?.provider && target?.model ? target : null;
  };
  return {
    selection,
    async generate({ previous, chunks, maxChars, signal }) {
      const target = selection();
      if (!target) throw failure('NO_SUMMARY_MODEL');
      const blocks = new Map(); let finish;
      const message = (role, text) => ({ id: randomUUID(), role, content: [{ type: 'text', text }] });
      const stream = ctx.llm.stream({ provider: target.provider, model: target.model, signal,
        purpose: 'history-rag-summary', maxTokens: runtime.config.memoryMaxTokens, toolHistory: [], tools: [],
        messages: [message('system', `${MEMORY_INSTRUCTION}\n摘要正文最多 ${maxChars} 个字符。`),
          message('user', JSON.stringify({ previous: { text: previous.text, source: previous.source, updatedAt: previous.updatedAt },
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
      if (finish?.kind !== 'stop') throw failure(finish?.kind === 'max-tokens' ? 'SUMMARY_TRUNCATED' : finish?.kind === 'aborted' ? 'ABORTED' : 'SUMMARY_FAILED');
      return [...blocks.values()].join('\n').trim();
    },
  };
}
