import { randomUUID } from 'node:crypto';
import { hash } from './text.js';

export class MemoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message = '记忆更新未完成') => new MemoryError(code, message);
export const renderMemory = entries => entries.map(entry => entry.text).join('\n\n');

// A conservative, tokenizer-independent estimate. It is explicitly not billed usage.
export function estimateTokens(text) {
  let bytes = 0;
  for (const char of text) bytes += char.codePointAt(0) < 128 ? 0.5 : Buffer.byteLength(char) / 2;
  return Math.ceil(bytes);
}
export function documentFromText(text, previous = [], now = Date.now(), source = 'manual') {
  if (text === renderMemory(previous)) return structuredClone(previous);
  const unused = [...previous];
  return text ? text.split('\n\n').map(part => {
    const index = unused.findIndex(entry => entry.text === part);
    if (index >= 0) return unused.splice(index, 1)[0];
    return { id: randomUUID(), text: part, locked: false, protectedAt: source === 'manual' ? now : 0, sources: [] };
  }) : [];
}
export function parsePatch(value) {
  let patch = value;
  if (typeof value === 'string') {
    let text = value.trim();
    if (/^```(?:json)?\s*\n[\s\S]*\n```$/u.test(text)) text = text.replace(/^```(?:json)?\s*\n/u, '').replace(/\n```$/u, '');
    try { patch = JSON.parse(text); } catch { throw fail('SUMMARY_INVALID_PATCH', '模型未返回有效的记忆变更'); }
  }
  if (!patch || Array.isArray(patch) || typeof patch !== 'object' || Object.keys(patch).some(k => k !== 'operations')
    || !Array.isArray(patch.operations) || patch.operations.length > 128) throw fail('SUMMARY_INVALID_PATCH');
  for (const op of patch.operations) {
    if (!op || Array.isArray(op) || !['add', 'replace', 'remove'].includes(op.op)
      || Object.keys(op).some(k => !['op', 'id', 'text', 'sources'].includes(k))
      || (op.op !== 'add' && (typeof op.id !== 'string' || !op.id))
      || (op.op === 'add' && op.id !== undefined)
      || (op.op !== 'remove' && (typeof op.text !== 'string' || !op.text.trim() || op.text.length > 20000))
      || (op.op === 'remove' && op.text !== undefined)
      || !Array.isArray(op.sources) || op.sources.length > 128 || op.sources.some(id => typeof id !== 'string')) throw fail('SUMMARY_INVALID_PATCH');
  }
  return patch;
}
export function applyMemoryPatch(previous, patch, sources, { explicit = false, compact = false } = {}) {
  const entries = structuredClone(previous);
  const touched = new Set(), available = new Map(sources.map(source => [source.id, source]));
  for (const op of parsePatch(patch).operations) {
    if (compact && op.op === 'add') throw fail('SUMMARY_INVALID_PATCH', '精简不能新增记忆');
    if ((!compact && !op.sources.length) || op.sources.some(id => !available.has(id))) throw fail('SUMMARY_INVALID_SOURCE', '记忆变更缺少有效原文依据');
    const evidence = op.sources.map(id => available.get(id));
    const index = entries.findIndex(entry => entry.id === op.id);
    if (op.op !== 'add') {
      if (index < 0 || touched.has(op.id)) throw fail('SUMMARY_INVALID_PATCH', '记忆条目不存在或被重复修改');
      touched.add(op.id);
      const entry = entries[index];
      if (entry.locked && !explicit) throw fail('SUMMARY_LOCKED', '模型尝试修改锁定的记忆');
      if (!explicit && entry.protectedAt && (compact || !evidence.some(source => source.time > entry.protectedAt))) {
        throw fail('SUMMARY_PROTECTED', '旧历史不能覆盖手动修订');
      }
      if (!explicit && !compact && Math.max(0, ...evidence.map(source => source.time || 0))
        < Math.max(0, ...(entry.sources || []).map(source => source.time || 0))) continue;
    }
    if (op.op === 'remove') { entries.splice(index, 1); continue; }
    const text = op.text.trim();
    if (op.op === 'add' && entries.some(entry => entry.text === text)) continue;
    const refs = evidence.map(({ id, sessionId, seq, start, end, time }) => ({ id, sessionId, seq, start, end, time }));
    if (op.op === 'add') entries.push({ id: randomUUID(), text, locked: false, protectedAt: explicit ? Date.now() : 0, sources: refs });
    else entries[index] = { ...entries[index], text,
      protectedAt: explicit ? Date.now() : entries[index].protectedAt,
      sources: compact ? entries[index].sources : refs };
  }
  if (compact && renderMemory(entries).length > renderMemory(previous).length) {
    throw fail('SUMMARY_INVALID_PATCH', '精简结果不能增加摘要长度');
  }
  return entries;
}
export const sourceHash = (role, text, time = 0) => hash(JSON.stringify([role, text, time]));
export function mergeRanges(ranges) {
  const result = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue;
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
export function uncoveredRanges(length, covered) {
  const result = []; let cursor = 0;
  for (const [start, end] of mergeRanges(covered)) { if (start > cursor) result.push([cursor, Math.min(start, length)]); cursor = Math.max(cursor, end); }
  if (cursor < length) result.push([cursor, length]);
  return result;
}

// Reconstruct exact messages for the one-time v1 migration and legacy sync callers.
export function messagesFromChunks(chunks) {
  const groups = new Map();
  for (const c of chunks) { const key = c.seq; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); }
  return [...groups.values()].map(parts => {
    parts.sort((a, b) => a.start - b.start); const first = parts[0];
    let end = 0, text = '';
    for (const p of parts) {
      if (p.start > end) throw fail('MEMORY_MIGRATION_GAP', '旧索引的原文片段不完整');
      text += Array.from(p.text).slice(Math.max(0, end - p.start)).join(''); end = Math.max(end, p.end);
    }
    return { seq: first.seq, role: first.role, time: first.time, text };
  }).sort((a, b) => a.seq - b.seq);
}
