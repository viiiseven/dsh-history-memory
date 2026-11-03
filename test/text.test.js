import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText, chunksFromSnapshot } from '../lib/text.js';
import { tempConfig, message, snapshot } from './helpers.js';

test('Unicode chunking preserves every character, overlap, and exact slices', () => {
  const text = '甲😀乙\n'.repeat(1100);
  const points = Array.from(text);
  const chunks = splitText(text, 800, 120);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, points.length);
  for (const [i, chunk] of chunks.entries()) {
    assert.equal(chunk.text, points.slice(chunk.start, chunk.end).join(''));
    if (i) assert.equal(chunk.start, chunks[i - 1].end - 120);
  }
});

test('Only original speech is indexed, even if shadowed by compaction', async t => {
  const config = await tempConfig(t);
  const data = snapshot('old', ['2001 年的原始旧话', '当时的完整回答']);
  data.events[0].surface = 'shadowed';
  data.events.push({ type: 'compaction/summary', seq: 2, time: 3, data: { text: '摘要不要入库' } });
  data.events.push({ type: 'user/message', seq: 3, time: 4, data: message('RAG 召回不要回流', 'history-rag') });
  data.events.push({ type: 'user/message', seq: 4, time: 5, data: message('系统注入不要回流', 'time-context') });
  const chunks = chunksFromSnapshot(data, config);
  assert.deepEqual(chunks.map(c => c.text), ['2001 年的原始旧话', '当时的完整回答']);
  assert.deepEqual(chunks.map(c => c.role), ['user', 'assistant']);
});

test('Long messages are indexed in full rather than truncated', async t => {
  const config = await tempConfig(t);
  const raw = '完整原文'.repeat(10000) + '这是末尾';
  const chunks = chunksFromSnapshot(snapshot('long', [raw]), config);
  assert.ok(chunks.at(-1).text.endsWith('这是末尾'));
  assert.equal(chunks.at(-1).end, Array.from(raw).length);
});
