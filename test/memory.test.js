import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryRag } from '../lib/runtime.js';
import { preStep } from '../lib/recall.js';
import { eventText } from '../lib/text.js';
import { tempConfig, snapshot, message, track, until } from './helpers.js';

async function setup(t, overrides = {}) {
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '', memoryDebounceMs: 0, memoryIntervalMs: 1000, ...overrides });
  const sessions = new Map([['a', snapshot('a', ['偏好使用中文回复', '项目 A 使用端口 8181'])]]);
  const source = { async listSessions() { return [...sessions.values()].map(s => ({ header: s.session })); }, async readSession(id) { return sessions.get(id); } };
  const runtime = track(t, new HistoryRag(config, source)); await runtime.start();
  await until(async () => (await runtime.status()).chunks === 2 && !runtime.pumpRunning && !runtime.scanRunning);
  return { runtime, config, sessions, source };
}
function generator(generate) { return { selection: () => ({ provider: 'synthetic', model: 'summary-model' }), generate }; }

test('Summary consumes only new raw chunks and persists the summary and processing receipts across restart', async t => {
  const { runtime, sessions, config, source } = await setup(t);
  const calls = [];
  runtime.memory.setGenerator(generator(async input => { calls.push(input); return calls.length === 1 ? '偏好中文；项目 A 端口 8181。' : '偏好中文；项目 A 端口 8282。'; }));
  await runtime.memory.kick();
  assert.equal(calls[0].chunks.length, 2);
  assert.equal((await runtime.memory.status()).pending, 0);
  sessions.set('b', snapshot('b', ['项目 A 现在改为端口 8282'])); runtime.markDirty('b');
  await until(async () => (await runtime.status()).chunks === 3 && !runtime.pumpRunning);
  runtime.memory.requestUpdate(); await until(() => calls.length === 2 && !runtime.memory.running);
  assert.equal(calls[1].chunks.length, 1); assert.equal(calls[1].previous.text, '偏好中文；项目 A 端口 8181。');
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start();
  assert.equal((await reopened.memory.read()).text, '偏好中文；项目 A 端口 8282。');
  assert.equal((await reopened.memory.status()).pending, 0);
  reopened.memory.setGenerator(generator(async () => { throw new Error('Should not call the model without new content'); }));
  await reopened.memory.kick(); assert.equal(reopened.memory.lastError, null);
});

test('Manual saving cancels an older generation, rejects stale editors and preserves the new summary as the next base', async t => {
  const { runtime } = await setup(t);
  let finish, started = false;
  runtime.memory.setGenerator(generator(async () => { started = true; return new Promise(resolve => { finish = resolve; }); }));
  const pending = runtime.memory.kick(); await until(() => started);
  const manual = await runtime.memory.save({ text: '用户手动修订的内容', autoUpdate: false, expectedRevision: 0 });
  finish('过时的自动摘要'); await pending;
  assert.equal((await runtime.memory.read()).text, '用户手动修订的内容');
  assert.equal((await runtime.memory.status()).pending, 2);
  await assert.rejects(runtime.memory.save({ text: '旧窗口', autoUpdate: true, expectedRevision: 0 }), { code: 'MEMORY_CONFLICT' });
  await runtime.memory.kick(); assert.equal((await runtime.memory.read()).revision, manual.revision);
  let base;
  runtime.memory.setGenerator(generator(async input => { base = input.previous; return '以手动修订为基础的增量摘要'; }));
  runtime.memory.requestUpdate(); await until(() => !runtime.memory.running);
  assert.equal(base.text, '用户手动修订的内容'); assert.equal(base.source, 'manual');
  assert.equal((await runtime.memory.read()).text, '以手动修订为基础的增量摘要');
});

test('Empty, oversized and timed-out generations preserve the saved summary and unprocessed raw text', async t => {
  for (const result of ['', '长'.repeat(300), null]) {
    const { runtime } = await setup(t, { memoryMaxChars: 256, memoryTimeoutMs: 100 });
    await runtime.memory.save({ text: '保留的旧摘要', autoUpdate: true, expectedRevision: 0 });
    runtime.memory.setGenerator(generator(async () => result === null ? new Promise(() => {}) : result));
    runtime.memory.requestUpdate(); await until(() => !runtime.memory.running);
    assert.equal((await runtime.memory.read()).text, '保留的旧摘要');
    assert.equal((await runtime.memory.status()).pending, 2); assert.ok(runtime.memory.retryAt > Date.now());
    const error = runtime.memory.lastError; await runtime.memory.kick(); assert.equal(runtime.memory.lastError, error);
    await runtime.close();
  }
});

test('Only the opening user turn receives a summary, even if later context has been compressed', async t => {
  const { runtime, config } = await setup(t);
  await runtime.memory.save({ text: '偏好中文；正在开发插件。', autoUpdate: false, expectedRevision: 0 });
  let requestHeader;
  const agent = { session: { id: 'new-chat', header: {}, surface: { nodes: [] }, eventAt() {}, append() {}, requestHeader: () => requestHeader } };
  const input = message('你好'); const decision = { kind: 'enter', messages: [input] };
  const run = (turn, step) => preStep(runtime)({ agent, messages: [input], turn, step }, async () => decision);
  const first = await run(1, 1); assert.equal(first.messages.length, 2);
  const injected = first.messages[1]; assert.equal(injected.source.kind, 'history-rag-memory');
  assert.ok(injected.content[0].text.includes('偏好中文'));
  assert.equal(eventText({ type: 'user/message', data: injected }, config), null);
  assert.equal((await run(1, 2)).messages.length, 1);
  assert.equal((await run(2, 1)).messages.length, 1);
  requestHeader = {};
  assert.equal((await run(1, 1)).messages.length, 1);
  requestHeader = undefined;
  runtime.recall = async () => { throw new Error('retrieval unavailable'); };
  assert.equal((await run(1, 1)).messages[1].source.kind, 'history-rag-memory');
});

test('Summary pending sources obey explicit session/workspace exclusions and deduplicate fork copies', async t => {
  const { runtime, sessions } = await setup(t, { excludeSessionIds: ['excluded'] });
  sessions.set('fork', snapshot('fork', ['偏好使用中文回复']));
  sessions.set('excluded', snapshot('excluded', ['不应进入摘要']));
  await runtime.scan(); await until(() => !runtime.pumpRunning && !runtime.scanRunning);
  assert.equal((await runtime.memory.status()).total, 2);
  let chunks;
  runtime.memory.setGenerator(generator(async input => { chunks = input.chunks; return '摘要'; }));
  await runtime.memory.kick(); assert.equal(chunks.length, 2);
  assert.ok(chunks.every(c => c.session_id !== 'excluded'));
});

test('Scheduler updates automatically after source changes without holding up the chat turn', async t => {
  const { runtime } = await setup(t);
  let calls = 0;
  runtime.memory.setGenerator(generator(async () => { calls++; return '后台自动生成的摘要'; }));
  await until(async () => (await runtime.memory.read()).text === '后台自动生成的摘要', 3000);
  assert.equal(calls, 1);
});

test('Summary model route is durable, rejects unknown providers and can return to following the chat', async t => {
  const { runtime, config, source } = await setup(t);
  runtime.memory.setGenerator({ ...generator(async () => '摘要'), hasProvider: p => p === 'configured' });
  await assert.rejects(runtime.memory.save({ text: '保留', autoUpdate: false, expectedRevision: 0,
    modelSelection: { provider: 'missing', model: 'chat' } }), { code: 'NO_SUMMARY_MODEL' });
  await runtime.memory.save({ text: '保留', autoUpdate: false, expectedRevision: 0,
    modelSelection: { provider: 'configured', model: 'chat' } });
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start();
  assert.deepEqual((await reopened.memory.read()).modelSelection, { provider: 'configured', model: 'chat' });
  const saved = await reopened.memory.save({ text: '保留', autoUpdate: false, expectedRevision: 1 });
  assert.deepEqual(saved.modelSelection, { provider: 'configured', model: 'chat' });
  assert.equal((await reopened.memory.save({ text: '保留', autoUpdate: false, expectedRevision: 2, modelSelection: null })).modelSelection, null);
});

test('Failed summary exposes a bounded diagnostic while preserving original pending chunks', async t => {
  const { runtime } = await setup(t);
  runtime.memory.setGenerator(generator(async () => { throw Object.assign(new Error('private response and key'), { code: 'RATE_LIMITED', status: 429 }); }));
  await runtime.memory.kick();
  const status = await runtime.memory.status();
  assert.equal(status.lastError.code, 'RATE_LIMITED'); assert.equal(status.lastError.status, 429);
  assert.equal(status.pending, 2); assert.equal(status.hasText, false);
  assert.ok(status.startedAt > 0 && status.finishedAt >= status.startedAt);
  assert.ok(!JSON.stringify(status).includes('private'));
});

test('One manual update drains 2,000 sessions in bounded batches without waiting between commits', async t => {
  const { runtime, sessions } = await setup(t, { memoryIntervalMs: 60000 });
  for (let i = 1; i < 2000; i++) sessions.set(`chat-${i}`, snapshot(`chat-${i}`, [`历史会话 ${i}`]));
  await runtime.scan();
  await until(async () => !runtime.pumpRunning && (await runtime.memory.status()).pending === 2001, 15000);
  await runtime.memory.save({ text: '初始摘要', autoUpdate: false, expectedRevision: 0 });
  const batches = [];
  const hashes = new Set();
  runtime.memory.setGenerator(generator(async ({ chunks, previous }) => {
    assert.equal(previous.revision, batches.length + 1);
    for (const chunk of chunks) {
      assert.ok(!hashes.has(chunk.hash));
      hashes.add(chunk.hash);
    }
    batches.push(chunks.length);
    return `已整理 ${hashes.size} 个片段`;
  }));
  runtime.memory.requestUpdate();
  await until(() => !runtime.memory.running, 15000);
  assert.deepEqual(batches, [...Array(250).fill(8), 1]);
  assert.equal((await runtime.memory.status()).pending, 0);
  assert.equal((await runtime.memory.read()).text, '已整理 2001 个片段');
});

test('Batching respects the text budget and leaves a long fragment intact for the next batch', async t => {
  const { runtime, sessions } = await setup(t, { chunkChars: 16000 });
  sessions.set('a', snapshot('a', ['甲'.repeat(9000), '乙'.repeat(9000)]));
  runtime.markDirty('a');
  await until(() => !runtime.pumpRunning);
  const batches = [];
  runtime.memory.setGenerator(generator(async ({ chunks }) => { batches.push(chunks.map(c => c.text)); return '摘要'; }));
  await runtime.memory.kick();
  assert.deepEqual(batches, [['甲'.repeat(9000)], ['乙'.repeat(9000)]]);
  assert.equal((await runtime.memory.status()).pending, 0);
});

test('A failed later batch keeps earlier commits and stops the drain until retry', async t => {
  const { runtime, sessions } = await setup(t);
  sessions.set('a', snapshot('a', Array.from({ length: 10 }, (_, i) => `原文片段 ${i}`)));
  runtime.markDirty('a');
  await until(() => !runtime.pumpRunning);
  let calls = 0;
  runtime.memory.setGenerator(generator(async () => {
    calls++;
    if (calls > 1) throw Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', status: 429 });
    return '首批已保存';
  }));
  await runtime.memory.kick();
  await runtime.memory.kick();
  assert.equal(calls, 2);
  assert.equal((await runtime.memory.read()).text, '首批已保存');
  assert.equal((await runtime.memory.status()).pending, 2);
  assert.equal(runtime.memory.lastError.code, 'RATE_LIMITED');
});

test('A truncated batch stays blocked after restart until an explicit retry or a changed budget', async t => {
  const { runtime, config, source } = await setup(t);
  await runtime.memory.save({ text: '已保存的摘要', autoUpdate: true, expectedRevision: 0 });
  const budgets = [];
  const fake = generator(async ({ maxTokens }) => {
    budgets.push(maxTokens);
    if (maxTokens === 32768) throw Object.assign(new Error('truncated'), { code: 'SUMMARY_TRUNCATED' });
    return '新预算完成的摘要';
  });
  runtime.memory.setGenerator(fake);
  await runtime.memory.kick();
  assert.deepEqual(budgets, [32768]);
  assert.equal((await runtime.memory.read()).text, '已保存的摘要');
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source));
  await reopened.start();
  await until(() => !reopened.pumpRunning && !reopened.scanRunning);
  reopened.memory.setGenerator(fake);
  await reopened.memory.kick();
  assert.deepEqual(budgets, [32768]);
  const blocked = await reopened.memory.status();
  assert.equal(blocked.pending, 2);
  assert.equal(blocked.lastError.code, 'SUMMARY_TRUNCATED');
  assert.equal(blocked.lastError.maxTokens, 32768);
  assert.equal(blocked.retryAt, 0);
  reopened.memory.requestUpdate();
  await until(() => !reopened.memory.running);
  assert.deepEqual(budgets, [32768, 32768]);
  reopened.reconfigure({ ...config, memoryMaxTokens: 48000 });
  reopened.memory.lastRunAt = 0;
  await reopened.memory.kick();
  assert.deepEqual(budgets, [32768, 32768, 48000]);
  assert.equal((await reopened.memory.status()).pending, 0);
  assert.equal((await reopened.memory.read()).text, '新预算完成的摘要');
});
