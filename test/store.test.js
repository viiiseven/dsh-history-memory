import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Database } from '../lib/database.js';
import { chunksFromSnapshot } from '../lib/text.js';
import { tempConfig, snapshot, track } from './helpers.js';

async function setup(t) {
  const config = await tempConfig(t);
  const db = new Database(join(config.dataDir, 'test.sqlite'));
  await db.ready;
  track(t, db);
  const a = snapshot('old', ['旧的蓝鲸部署原文', '另一个话题'], 'A');
  const b = snapshot('fork', ['旧的蓝鲸部署原文'], 'B');
  const ac = chunksFromSnapshot(a, config), bc = chunksFromSnapshot(b, config);
  await db.call('sync', a.session, ac); await db.call('sync', b.session, bc);
  return { config, db, ac, bc };
}

test('SQLite survives restart and reuses embeddings for identical source text', async t => {
  const { config, db } = await setup(t);
  const pending = await db.call('pending', 'model-a', 16);
  assert.equal(pending.length, 2);
  await db.call('putEmbeddings', 'model-a', pending.map(p => p.hash), pending.map(() => new Float32Array([1, 0])));
  assert.equal((await db.call('status', 'model-a')).embeddedChunks, 3);
  await db.close();
  const reopened = new Database(join(config.dataDir, 'test.sqlite'));
  track(t, reopened);
  const state = await reopened.call('status', 'model-a');
  assert.equal(state.sessions, 2); assert.equal(state.pending, 0);
  assert.equal((await reopened.call('status', 'model-b')).pending, 3);
});

test('Cosine recall returns original text and enforces scopes, exclusions and visible-context deduplication', async t => {
  const { db, ac } = await setup(t);
  await db.call('putEmbeddings', 'm', ac.map(c => c.hash), [new Float32Array([1, 0]), new Float32Array([0, 1])]);
  const opts = { topK: 5, minScore: 0.5, scope: 'all' };
  let hits = await db.search('m', [1, 0], opts);
  assert.equal(hits.length, 1); assert.equal(hits[0].text, '旧的蓝鲸部署原文');
  hits = await db.search('m', [1, 0], { ...opts, scope: 'workspace', cwd: 'B' });
  assert.equal(hits[0].sessionId, 'fork');
  hits = await db.search('m', [1, 0], { ...opts, excludeWorkspaces: ['B'], currentSessionId: 'old', currentVisibleSeqs: [0] });
  assert.deepEqual(hits, []);
  await assert.rejects(db.search('m', [1, 0, 0], opts), /维度/);
});

test('Source edits replace obsolete chunks while unchanged chunks retain vectors', async t => {
  const { config, db, ac } = await setup(t);
  await db.call('putEmbeddings', 'm', ac.map(c => c.hash), [new Float32Array([1, 0]), new Float32Array([0, 1])]);
  const changed = snapshot('old', ['修正后的原文'], 'A');
  await db.call('sync', changed.session, chunksFromSnapshot(changed, config));
  assert.equal((await db.call('status', 'm')).chunks, 2);
  assert.equal((await db.call('pending', 'm', 16)).length, 1);
});

test('Failed batches back off; other historical chunks can still progress', async t => {
  const { db } = await setup(t);
  const pending = await db.call('pending', 'm', 1);
  await db.call('failed', 'm', pending.map(p => p.hash));
  assert.equal((await db.call('pending', 'm', 16)).length, 1);
});

test('A model dimension mismatch rolls the whole batch back', async t => {
  const { db, ac } = await setup(t);
  await db.call('putEmbeddings', 'm', [ac[0].hash], [new Float32Array([1, 0])]);
  await assert.rejects(db.call('putEmbeddings', 'm', [ac[1].hash], [new Float32Array([1, 0, 0])]), /维度/);
  assert.equal((await db.call('status', 'm')).pending, 1);
});
