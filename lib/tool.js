import { RECALL_KIND, recallContext } from './context.js';
import { hash } from './text.js';

export const RECALL_TOOL = 'history_recall';
const NOTICE = '回忆：';

export function toolText(value) { return JSON.stringify(value); }

export function toolResult(hits, mode, budget) {
  const result = { kind: RECALL_KIND, version: 1, mode, notice: NOTICE, hits: [], truncated: false };
  for (const hit of hits) {
    const item = { id: hit.id, sessionId: hit.sessionId, seq: hit.seq, part: hit.part, role: hit.role,
      time: hit.time, cwd: hit.cwd, text: hit.text, hash: hit.hash, deliveredHash: hash(hit.text), score: hit.score, truncated: false };
    result.hits.push(item);
    if (toolText(result).length > budget) {
      item.truncated = true; result.truncated = true;
      let low = 0, high = hit.text.length, best = '';
      while (low <= high) {
        const end = Math.floor((low + high) / 2);
        let text = hit.text.slice(0, end);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        item.text = text;
        if (toolText(result).length <= budget) { best = text; low = end + 1; }
        else high = end - 1;
      }
      item.text = best;
      item.deliveredHash = hash(best);
      if (!best) result.hits.pop();
      break;
    }
  }
  return result;
}

const hitSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'sessionId', 'seq', 'part', 'role', 'time', 'cwd', 'text', 'hash', 'deliveredHash', 'score', 'truncated'],
  properties: { id: { type: 'string' }, sessionId: { type: 'string' }, seq: { type: 'integer' }, part: { type: 'integer' },
    role: { type: 'string' }, time: { type: 'number' }, cwd: { type: 'string' }, text: { type: 'string' }, hash: { type: 'string' }, deliveredHash: { type: 'string' },
    score: { type: 'number' }, truncated: { type: 'boolean' } } };

export function recallTool(runtime) {
  return {
    name: RECALL_TOOL,
    description: '主动回忆的工具。mode=keyword 按字面关键词检索（多个词用空格分隔，所有词都需命中；不需要 Embedding）；mode=embedding 普通回忆',
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', description: '非空关键词或想回忆的问题，最多 4000 个字符' },
      mode: { type: 'string', enum: ['keyword', 'embedding'], description: 'keyword=字面关键词；embedding=向量语义；默认 embedding' },
    } },
    output: {
      schema: { type: 'object', additionalProperties: false,
        required: ['kind', 'version', 'mode', 'notice', 'hits', 'truncated'], properties: {
          kind: { type: 'string', enum: [RECALL_KIND] }, version: { type: 'integer', enum: [1] },
          mode: { type: 'string', enum: ['keyword', 'embedding'] }, notice: { type: 'string' },
          hits: { type: 'array', items: hitSchema }, truncated: { type: 'boolean' },
        } },
      render: (_args, value) => [{ type: 'text', text: toolText(value) }],
      presentationMeta: (_args, value) => ({ historyRagRecall: true, recallRefs: value.hits.map(hit => ({ id: hit.id, hash: hit.hash })) }),
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['query', 'mode'].includes(k))
        || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4000
        || (args.mode !== undefined && !['keyword', 'embedding'].includes(args.mode))) throw new Error('history_recall 需要非空 query，以及 keyword 或 embedding 模式');
      exec.signal?.throwIfAborted();
      const mode = args.mode || 'embedding';
      if (mode === 'embedding' && !runtime.client.configured) throw new Error('尚未配置 Embedding，请使用 mode="keyword" 检索本地原文');
      const context = recallContext(exec.agent);
      const hits = mode === 'keyword' ? await runtime.keywordRecall(args.query, context, exec.signal)
        : await runtime.recall(args.query, context, exec.signal);
      exec.signal?.throwIfAborted();
      return toolResult(hits, mode, runtime.config.maxContextChars);
    },
    presentCall(args) { return { card: 'generic', title: '主动回忆', kind: 'search', rawInput: typeof args?.query === 'string' ? args.query : '' }; },
  };
}
