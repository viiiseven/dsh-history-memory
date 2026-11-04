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
    ['other', snapshot('other', ['另一会话的原始旧话'], 'B')],
    ['archived', snapshot('archived', ['归档内容不得检索'], 'B')],
  ]);
  const archived = new Set(['archived']);
  const source = { async listSessions() { return [...sessions.values()].map(s => ({ header: s.session, persisted: true, live: false })); }, async readSession(id) { return structuredClone(sessions.get(id)); } };
  const client = fakeClient();
  const runtime = track(t, new HistoryRag(config, source, { client, archivedSessionIds: () => [...archived] }));
  await runtime.start();
  await until(async () => (await runtime.status()).coverage === 1);
  return { runtime, sessions, client, config, source, archived };
}

test('Backfills old active sessions, excludes archives, and incrementally embeds new original speech', async t => {
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

test('Archive/deletion removes stale RAG and summary sources; unarchive reuses paid vectors and receipts', async t => {
  const { runtime, sessions, archived, client } = await setup(t);
  const batch = await runtime.db.call('memoryBatch', runtime.config, 8000);
  await runtime.db.call('commitMemoryDocument', 0, [], batch.receipts, runtime.config);
  assert.equal((await runtime.memory.status()).pending, 0);
  const paid = client.calls.filter(call => !call.query).length;
  archived.add('ancient'); sessions.delete('other');
  // Archive filtering applies even before the next full reconciliation.
  assert.ok(!(await runtime.recall('蓝鲸')).some(hit => hit.sessionId === 'ancient'));
  assert.ok(!(await runtime.keywordRecall('部署')).some(hit => hit.sessionId === 'ancient'));
  await runtime.scan(); await until(() => !runtime.pumpRunning);
  assert.equal((await runtime.status()).sessions, 0);
  assert.equal((await runtime.status()).chunks, 0);
  assert.equal((await runtime.memory.status()).total, 0);
  assert.deepEqual(await runtime.recall('蓝鲸'), []);
  assert.deepEqual(await runtime.keywordRecall('旧话'), []);
  assert.equal(await runtime.db.call('validMemoryReceipts', batch.receipts, runtime.config), false);
  archived.delete('ancient'); await runtime.scan(); await until(() => !runtime.pumpRunning);
  assert.equal((await runtime.status()).sessions, 1);
  assert.equal((await runtime.status()).coverage, 1);
  assert.equal((await runtime.memory.status()).pending, 0);
  assert.equal(client.calls.filter(call => !call.query).length, paid);
  assert.ok((await runtime.recall('蓝鲸')).some(hit => hit.sessionId === 'ancient'));
});

test('Failed, malformed or live-only listings cannot purge persisted history', async t => {
  const { runtime, source } = await setup(t);
  source.listSessions = async () => { throw new Error('offline'); };
  await assert.rejects(runtime.scan(), /offline/);
  assert.equal((await runtime.status()).sessions, 2);
  source.listSessions = async () => [{ header: { id: 'ancient' } }, {}];
  await assert.rejects(runtime.scan(), /会话列表格式/);
  assert.equal((await runtime.status()).sessions, 2);
  source.listSessions = async () => [];
  runtime.canPruneMissing = () => false;
  await runtime.scan();
  assert.equal((await runtime.status()).sessions, 2);
  runtime.canPruneMissing = () => true;
  await runtime.scan();
  assert.equal((await runtime.status()).sessions, 0);
});

test('A stale session read cannot restore a deleted session after reconciliation', async t => {
  const { runtime, sessions, source } = await setup(t);
  const originalRead = source.readSession;
  let finish;
  source.readSession = id => id === 'ancient'
    ? new Promise(resolve => { finish = () => resolve(snapshot('ancient', ['删除前已开始读取的新增内容'])); }) : originalRead(id);
  runtime.markDirty('ancient'); await until(() => Boolean(finish));
  sessions.delete('ancient'); await runtime.scan();
  finish(); await until(() => !runtime.pumpRunning);
  assert.equal((await runtime.status()).sessions, 1);
  assert.deepEqual(await runtime.keywordRecall('删除前'), []);
  assert.equal((await runtime.memory.status()).total, 1);
});

test('A live session created during listing survives reconciliation even if absent from that snapshot', async t => {
  const { runtime, source, sessions } = await setup(t);
  const previousList = await source.listSessions();
  let finish;
  source.listSessions = () => new Promise(resolve => { finish = () => resolve(previousList); });
  const scan = runtime.scan(); await until(() => Boolean(finish));
  sessions.set('new', snapshot('new', ['核对期间刚创建的新会话']));
  runtime.markDirty('new'); await until(() => !runtime.pumpRunning);
  finish(); await scan; await until(() => !runtime.pumpRunning);
  assert.equal((await runtime.status()).sessions, 3);
  assert.equal((await runtime.keywordRecall('刚创建'))[0].sessionId, 'new');
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
  assert.ok(context.content[0].text.includes('另一会话的原始旧话'));
  assert.ok(!context.content[0].text.includes('归档内容不得检索'));
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
  assert.equal((await replacement.status()).sessions, 0);
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
