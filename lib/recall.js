import { randomUUID } from 'node:crypto';
import { isHuman, textBlocks, hash } from './text.js';
import { NAME } from './config.js';
import { recallContext } from './context.js';

export function latestQuery(messages, config) {
  return messages.filter(m => isHuman(m, config)).map(m => textBlocks(m.content)).filter(Boolean).join('\n');
}

export function recallMessage(hits, budget) {
  if (!hits.length) return null;
  const boundary = `HISTORY_RAG_${randomUUID()}`;
  const intro = '回忆：';
  let text = `${intro}\n${boundary}_BEGIN\n`;
  let count = 0;
  const refs = [];
  for (const h of hits) {
    const header = JSON.stringify({ session: h.sessionId, seq: h.seq, part: h.part, role: h.role,
      time: h.time, cwd: h.cwd, score: Number(h.score.toFixed(4)) });
    const remaining = budget - text.length - header.length - boundary.length - 50;
    if (remaining <= 0) break;
    let raw = h.text.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(raw)) raw = raw.slice(0, -1);
    const suffix = raw.length < h.text.length ? '\n[片段因注入预算截断]' : '';
    const block = `${header}\n${raw}${suffix}\n\n`;
    if (text.length + block.length + boundary.length + 5 > budget) break;
    text += block; count++;
    refs.push(Object.freeze({ id: h.id || `${h.sessionId}:${h.seq}:${h.part}`, hash: h.hash || hash(h.text) }));
  }
  if (!count) return null;
  text += `${boundary}_END`;
  return Object.freeze({ id: randomUUID(), role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: NAME, form: 'recall', recallRefs: Object.freeze(refs), recallBodyHash: hash(text) }),
  });
}

export function preStep(runtime) {
  return async ({ agent, messages = [], signal, turn, step }, next) => {
    if (!signal?.aborted) runtime.memory?.retire(agent?.session, turn, step);
    const decision = await next();
    if (decision.kind === 'enter' && !signal?.aborted) runtime.memoryEdits?.observe(agent, messages, turn, step, runtime.config);
    if (decision.kind !== 'enter' || signal?.aborted || !decision.messages.length) return decision;
    // Query only genuine fresh user input. Tool-only continuations keep the
    // already-entered recall message instead of spending another embedding call.
    const query = latestQuery(messages, runtime.config);
    if (!query) return decision;
    runtime.memory?.observe(agent);
    const summary = turn === 1 && step === 1 ? runtime.memory?.message(agent?.session) : null;
    const accepted = summary ? [...decision.messages, summary] : decision.messages;
    try {
      const hits = await runtime.recall(query, recallContext(agent, accepted), signal);
      if (signal?.aborted || runtime.closed) return decision;
      const message = recallMessage(hits, runtime.config.maxContextChars);
      if (!message) return summary ? { ...decision, messages: accepted } : decision;
      return { ...decision, messages: [...accepted, message] };
    } catch (error) {
      if (!signal?.aborted && !runtime.closed) runtime.recordError('recall', error);
      return summary && !signal?.aborted && !runtime.closed ? { ...decision, messages: accepted } : decision;
    }
  };
}
