import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { HistoryRag } from '../lib/runtime.js';
import { preStep, recallMessage } from '../lib/recall.js';
import { tempConfig, snapshot, message, until, fakeClient, track } from './helpers.js';

async function setup(t, configChanges = {}) {
  const config = await tempConfig(t, configChanges);
  const sessions = new Map([
    ['ancient', snapshot('ancient', ['多年前的蓝鲸部署记录', '原始回答全文'], 'A')],
    ['archived', snapshot('archived', ['已归档的原始旧话'], 'B')],
  ]);
  const source = { async listSessions() { return [...sessions.values()].map(s => ({ header: s.session, persisted: true, live: false })); }, async readSession(id) { return structuredClone(sessions.get(id)); } };
  const client = fakeClient();
  const runtime = track(t, new HistoryRag(config, source, { client }));
  await runtime.start();
  await until(async () => (await runtime.status()).coverage === 1);
  return { runtime, sessions, client, config };
}

test('Automatically backfills old and archived sessions, then incrementally embeds new original speech', async t => {
  const { runtime, sessions, client } = await setup(t);
  assert.equal((await runtime.status()).sessions, 2);
  const calls = client.calls.filter(c => !c.query).length;
  await runtime.scan(); await until(() => !runtime.pumpRunning);
  await delay(600);
  assert.equal(client.calls.filter(c => !c.query).length, calls);
  sessions.set('new', snapshot('new', ['新会话的蓝鲸原话'], 'C'));
  runtime.markDirty('new');
  await until(async () => (await runtime.status()).chunks === 4 && (await runtime.status()).coverage === 1);
  const hits = await runtime.recall('怎么部署蓝鲸');
  assert.ok(hits.some(h => h.text === '新会话的蓝鲸原话'));
});

test('Default background batches index all history with a provider that accepts at most ten inputs', async t => {
  const config = await tempConfig(t);
  const original = snapshot('ten-input-provider', Array.from({ length: 17 }, (_, i) => `独立历史原文 ${i}`));
  const source = { async listSessions() { return [{ header: original.session }]; }, async readSession() { return original; } };
  const client = fakeClient();
  const embed = client.embed.bind(client);
  client.embed = async (texts, options) => { assert.ok(texts.length <= 10, 'Provider rejects larger batches'); return embed(texts, options); };
  const runtime = track(t, new HistoryRag(config, source, { client }));
  await runtime.start();
  await until(async () => { const s = await runtime.status(); return s.chunks === 17 && s.coverage === 1; });
  assert.ok(client.calls.length >= 2);
  assert.equal(runtime.lastError, null);
});

test('Pre-step automatically injects original snippets without any tool call and excludes visible current events', async t => {
  const { runtime } = await setup(t);
  const handler = preStep(runtime);
  const user = message('蓝鲸是怎么部署的');
  const decision = { kind: 'enter', messages: [user] };
  const payload = { agent: { session: { id: 'ancient', header: { cwd: 'A' }, surface: { nodes: [0, 1] } } }, messages: [user], signal: new AbortController().signal, step: 1 };
  const result = await handler(payload, async () => decision);
  assert.equal(result.messages.length, 2);
  const context = result.messages[1];
  assert.equal(context.source.kind, 'history-rag');
  assert.ok(context.content[0].text.includes('已归档的原始旧话'));
  assert.ok(!context.content[0].text.includes('多年前的蓝鲸部署记录'));
  assert.equal(decision.messages.length, 1);
});

test('Rejects, cancellations, synthetic inputs and tool-only steps do not trigger retrieval', async t => {
  const { runtime, client } = await setup(t);
  const handler = preStep(runtime);
  const payload = { agent: { session: { id: 'chat', header: {} } }, messages: [message('注入', 'history-rag')], signal: new AbortController().signal };
  const decision = { kind: 'enter', messages: payload.messages };
  assert.equal(await handler(payload, async () => decision), decision);
  const rejected = { kind: 'reject' };
  assert.equal(await handler(payload, async () => rejected), rejected);
  assert.equal(client.calls.filter(c => c.query).length, 0);
});

test('Unconfigured embedding keeps raw indexing active and never substitutes keyword/hash retrieval', async t => {
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '' });
  const source = { async listSessions() { return [{ header: { id: 'a' } }]; }, async readSession() { return snapshot('a', ['原始文字']); } };
  const runtime = track(t, new HistoryRag(config, source));
  await runtime.start();
  await until(async () => (await runtime.status()).chunks === 1);
  assert.equal((await runtime.status()).configured, false);
  assert.deepEqual(await runtime.recall('文字'), []);
});

test('A hanging provider is bounded by the recall budget and chat proceeds', async t => {
  const { runtime } = await setup(t, { recallTimeoutMs: 100 });
  runtime.client.embed = () => new Promise(() => {});
  const input = message('蓝鲸');
  const decision = { kind: 'enter', messages: [input] };
  const begin = Date.now();
  const result = await preStep(runtime)({ agent: { session: { id: 'chat', header: {} } }, messages: [input] }, async () => decision);
  assert.equal(result, decision);
  assert.ok(Date.now() - begin < 1000);
});

test('Recall injection is bounded, attributed and preserves the original text', () => {
  const hit = { sessionId: 's', seq: 9, part: 1, role: 'assistant', time: 1, cwd: 'A', score: 0.9, text: '逐字原文😀'.repeat(300) };
  const result = recallMessage([hit], 600);
  assert.ok(result);
  assert.ok(result.content[0].text.length <= 600);
  assert.ok(result.content[0].text.includes('逐字原文😀'));
});

test('A second index writer is rejected; clean disposal releases the lease', async t => {
  const { runtime, config } = await setup(t);
  const source = { async listSessions() { return []; } };
  const duplicate = track(t, new HistoryRag(config, source));
  await assert.rejects(duplicate.start(), /另一 DSH/);
  await runtime.close();
  const replacement = track(t, new HistoryRag(config, source));
  await replacement.start();
  assert.equal((await replacement.status()).sessions, 2);
});

test('Unreadable sessions remain visible in status and are retried on the next scan', async t => {
  const config = await tempConfig(t);
  let broken = true;
  const source = {
    async listSessions() { return [{ header: { id: 'bad' } }, { header: { id: 'good' } }]; },
    async readSession(id) { if (id === 'bad' && broken) throw Object.assign(new Error('synthetic failure'), { code: 'SOURCE_UNREADABLE' }); return snapshot(id, ['原始文字']); },
  };
  const runtime = track(t, new HistoryRag(config, source, { client: fakeClient() }));
  await runtime.start();
  await until(async () => (await runtime.status()).sessions === 1);
  const state = (await runtime.status()).state;
  assert.equal(state.lastScan.discoveredSessions, 2);
  assert.equal(state.sessionFailures[0].sessionId, 'bad');
  broken = false; await runtime.scan();
  await until(async () => (await runtime.status()).sessions === 2 && (await runtime.status()).state.sessionFailures.length === 0);
});

test('Live model switching cancels the old generation and never stores a late vector under the new model', async t => {
  const { runtime, sessions, config } = await setup(t);
  const oldIdentity = runtime.client.identity;
  let finishOld, started = false;
  runtime.client.embed = async texts => {
    started = true;
    await new Promise(resolve => { finishOld = resolve; });
    return texts.map(() => new Float32Array([1, 0]));
  };
  sessions.set('switching', snapshot('switching', ['切换过程中刚写入的原文']));
  runtime.markDirty('switching');
  await until(() => started);
  const fetchBefore = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetchBefore; });
  globalThis.fetch = async (_url, options) => new Response(JSON.stringify({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }));
  runtime.reconfigure({ ...config, embeddingModel: 'new-live-model' });
  finishOld();
  await until(async () => { const s = await runtime.status(); return s.coverage === 1 && s.dimensions === 3; });
  assert.equal((await runtime.db.call('status', oldIdentity)).pending, 1);
  assert.equal((await runtime.recall('原文'))[0].score, 1);
});

test('A recall interrupted by settings hot reload skips cleanly instead of reporting a false failure', async t => {
  const { runtime, config } = await setup(t);
  runtime.client.embed = () => new Promise(() => {});
  const result = runtime.recall('切换期间的查询');
  runtime.reconfigure({ ...config, embeddingEndpoint: '', embeddingModel: '' });
  assert.deepEqual(await result, []);
  assert.equal(runtime.lastError, null);
});
