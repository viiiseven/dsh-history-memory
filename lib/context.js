import { hash, textBlocks } from './text.js';

export const RECALL_KIND = 'history-rag-recall';

function validRef(value) {
  return value && typeof value.id === 'string' && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash);
}

// Read complete JSON records even when a Code Mode result adds log lines around
// them. A truncated or rewritten record grants no remembered/seen state.
function recordsIn(text) {
  const result = [];
  for (const match of text.matchAll(/\{\s*"kind"\s*:\s*"history-rag-recall"/g)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = match.index; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { result.push(JSON.parse(text.slice(match.index, i + 1))); } catch {}
        break;
      }
    }
  }
  return result;
}

function legacyRefs(text) {
  const marker = text.match(/^HISTORY_RAG_([a-f0-9-]+)_BEGIN\n/m);
  if (!marker) return [];
  const end = text.indexOf(`HISTORY_RAG_${marker[1]}_END`, marker.index + marker[0].length);
  if (end < 0) return [];
  const body = text.slice(marker.index + marker[0].length, end);
  const headers = [];
  for (const match of body.matchAll(/^\{"session":.*\}\n/gm)) {
    try {
      const v = JSON.parse(match[0]);
      if (typeof v.session === 'string' && Number.isSafeInteger(v.seq) && Number.isSafeInteger(v.part)
        && ['user', 'assistant', 'tool'].includes(v.role) && typeof v.score === 'number'
        && Object.keys(v).every(k => ['session', 'seq', 'part', 'role', 'time', 'cwd', 'score'].includes(k))) headers.push({ match, value: v });
    } catch {}
  }
  const refs = [];
  headers.forEach(({ match, value }, i) => {
    let raw = body.slice(match.index + match[0].length, headers[i + 1]?.match.index ?? body.length);
    if (!raw.endsWith('\n\n') || raw.endsWith('[片段因注入预算截断]\n\n')) return;
    raw = raw.slice(0, -2);
    refs.push({ id: `${value.session}:${value.seq}:${value.part}`, hash: hash(raw) });
  });
  return refs;
}

export function visibleRecallRefs(message) {
  const text = textBlocks(message?.content);
  if (message?.source?.kind === 'history-rag') {
    const refs = message.source.recallRefs;
    if (Array.isArray(refs)) return message.source.recallBodyHash === hash(text) ? refs.filter(validRef) : [];
    return legacyRefs(text);
  }
  if (message?.role !== 'tool') return [];
  return recordsIn(text).flatMap(value => value.kind === RECALL_KIND && value.version === 1 && Array.isArray(value.hits)
    ? value.hits.filter(hit => validRef(hit) && typeof hit.text === 'string'
      && hash(hit.text) === hit.deliveredHash && (hit.truncated === true || hit.deliveredHash === hit.hash)) : []);
}

export function recallContext(agent, proposed = []) {
  const session = agent?.session;
  const visible = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
  const refs = [...visible, ...proposed].flatMap(visibleRecallRefs);
  return {
    cwd: session?.header?.cwd || '', currentSessionId: session?.id,
    currentVisibleSeqs: Array.from(session?.surface?.nodes || []),
    excludeHashes: [...new Set(refs.map(ref => ref.hash))],
  };
}
