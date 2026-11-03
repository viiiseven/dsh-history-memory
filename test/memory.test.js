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

test('Summary injection needs no Embedding, survives replay without duplication, and is restored after compression', async t => {
  const { runtime, config } = await setup(t);
  await runtime.memory.save({ text: '偏好中文；正在开发插件。', autoUpdate: false, expectedRevision: 0 });
  let visible = [];
  const agent = { session: { id: 'new-chat', header: {}, surface: { nodes: [] }, deriveMessages: () => visible } };
  const input = message('你好'); const decision = { kind: 'enter', messages: [input] };
  const run = () => preStep(runtime)({ agent, messages: [input] }, async () => decision);
  const first = await run(); assert.equal(first.messages.length, 2);
  const injected = first.messages[1]; assert.equal(injected.source.kind, 'history-rag-memory');
  assert.ok(injected.content[0].text.includes('偏好中文'));
  assert.equal(eventText({ type: 'user/message', data: injected }, config), null);
  visible = [JSON.parse(JSON.stringify(injected))]; assert.equal((await run()).messages.length, 1);
  visible = [message('之前的信息已压缩', 'compaction')]; assert.equal((await run()).messages.length, 2);
  runtime.recall = async () => { throw new Error('retrieval unavailable'); };
  assert.equal((await run()).messages[1].source.kind, 'history-rag-memory');
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
