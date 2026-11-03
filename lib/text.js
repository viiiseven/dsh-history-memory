import { createHash } from 'node:crypto';

export function hash(value) { return createHash('sha256').update(value).digest('hex'); }

// Split only at Unicode code-point boundaries; every slice is exact source text.
export function splitText(text, size, overlap) {
  const chars = Array.from(text);
  const chunks = [];
  for (let start = 0; start < chars.length; start += size - overlap) {
    const end = Math.min(start + size, chars.length);
    chunks.push({ start, end, text: chars.slice(start, end).join('') });
    if (end === chars.length) break;
  }
  return chunks;
}

export function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}

export function isHuman(message, config) {
  return message?.role === 'user' && config.humanSourceKinds.includes(message.source?.kind);
}

export function eventText(event, config) {
  if (event.type === 'user/message') {
    return isHuman(event.data, config) ? { role: 'user', text: textBlocks(event.data.content) } : null;
  }
  if (event.type === 'assistant/message') {
    return { role: 'assistant', text: textBlocks(event.data?.message?.content) };
  }
  if (event.type === 'tool/result' && config.includeToolResults) {
    const message = event.data?.message;
    if (event.data?.meta?.historyRagRecall === true || /"kind"\s*:\s*"history-rag-recall"/.test(textBlocks(message?.content))) return null;
    return message ? { role: 'tool', text: textBlocks(message.content) } : null;
  }
  return null;
}

export function chunksFromSnapshot(snapshot, config) {
  const { session, events } = snapshot;
  const chunks = [];
  for (const event of events) {
    const extracted = eventText(event, config);
    if (!extracted?.text) continue;
    for (const [part, chunk] of splitText(extracted.text, config.chunkChars, config.chunkOverlap).entries()) {
      chunks.push({ id: `${session.id}:${event.seq}:${part}`, sessionId: session.id,
        seq: event.seq, part, role: extracted.role, time: event.time, cwd: session.cwd || '',
        start: chunk.start, end: chunk.end, text: chunk.text, hash: hash(chunk.text) });
    }
  }
  return chunks;
}
