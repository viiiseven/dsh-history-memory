import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../lib/database.js';
import { hostSummarizer } from '../lib/host-summary.js';
import * as plugin from '../index.js';
import { tempConfig, track, until } from './helpers.js';

const sdkRoot = process.env.HISTORY_RAG_TEST_SDK;

test('Installed DSH LLM and Connection generate, edit and inject a durable summary using the default chat model', { skip: !sdkRoot }, async t => {
  const sdk = name => import(pathToFileURL(join(sdkRoot, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ Context }, { SessionStore, Session }, { SessionQueryEngine }, { HostConnectionService }, { LlmRuntime, LlmAdapter, createUserMessage, createSystemMessage, createAssistantMessage }] = await Promise.all([
    sdk('cordis'), sdk('dsh-session'), sdk('dsh-session-query'), sdk('dsh-client-connection'), sdk('dsh-llm'),
  ]);
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '', memoryDebounceMs: 0 });
  const ctx = new Context(); new SessionStore(ctx); new SessionQueryEngine(ctx); new HostConnectionService(ctx, [], { isAuthenticated: () => true }); new LlmRuntime(ctx);
  ctx.provide('agents', {}); ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'native-summary' }) });
  ctx.provide('workspaceRegistry', { archivedSessionIds: ['summary-archived'] });
  const calls = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, toolUpdate: 'addition-only', reasoning: {
        defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'off', name: 'Off' }],
      } };
    }
    async listModels(provider) { return [{ provider, id: 'native-summary', name: '默认摘要模型' }, { provider, id: 'picked-summary', name: '指定摘要模型' }]; }
    async *stream(options) {
      calls.push(options);
      if (options.maxTokens < 32768) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      const input = options.purpose === 'history-rag-summary' ? JSON.parse(options.messages[0].content[0].text) : null;
      const response = input ? JSON.stringify({ operations: [{ op: 'add', text: '用户偏好中文。', sources: [input.additions[0].id] }] }) : '回复';
      yield { type: 'reasoning-delta', index: 0, text: '此内容不得进入摘要' };
      yield { type: 'text-delta', index: 1, text: response };
      yield { type: 'block-end', index: 1, block: { type: 'text', text: response } };
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, reasoningTokens: 10, cacheReadTokens: 20 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['synthetic'], new Adapter());
  const old = ctx.sessions.create('summary-original', { meta: { cwd: process.cwd(), createdAt: 1 } });
  old.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '我喜欢用中文聊天' }] }), { surfaceOp: 'append' });
  const archived = ctx.sessions.create('summary-archived', { meta: { cwd: process.cwd(), createdAt: 2 } });
  archived.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '已归档内容不能进入摘要' }] }), { surfaceOp: 'append' });
  track(t, { close: () => ctx.fiber.dispose() });
  await ctx.plugin(plugin, config).await();
  const handler = ctx.connection.createSharedFetchHandler('/api'); const peer = ctx.connection.browserPeer;
  const rpc = async (action, payload = {}, principal = peer) => {
    const response = await handler.fetch(new Request(`http://host/api/history-rag/${action}`, { method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'memory', method: `history-rag/${action}`, payload }) }), principal);
    if (response.status !== 200) return response;
    return (await response.json()).result;
  };
  const db = track(t, new Database(join(config.dataDir, 'history.sqlite')));
  await until(async () => (await db.call('memoryCounts')).total === 1);
  await until(async () => (await rpc('status')).value?.memory?.modelReady);
  await rpc('memory-update');
  await until(async () => (await rpc('memory')).value?.text === '用户偏好中文。');
  assert.equal(calls[0].model, 'native-summary'); assert.equal(calls[0].purpose, 'history-rag-summary');
  assert.deepEqual(calls.map(({ maxTokens, reasoningEffort }) => [maxTokens, reasoningEffort]), [[32768, 'high']]);
  assert.equal(calls[0].toolHistory, undefined);
  assert.equal(calls[0].messages.length, 1); assert.equal(calls[0].messages[0].role, 'user');
  assert.ok(!calls[0].messages[0].content[0].text.includes('已归档内容不能进入摘要'));
  assert.match(calls[0].system, /4500 字符为目标.*上限 6000/);
  assert.match(calls[0].system, /局部变更/);
  assert.equal((await rpc('status')).value.memory.usage.today.inputTokens, 120);
  const models = (await rpc('memory-models')).value;
  assert.equal(models.providers[0].id, 'synthetic');
  assert.ok(models.providers[0].models.some(m => m.id === 'picked-summary'));
  assert.equal((await rpc('memory-models', {}, { principal: { kind: 'guest' } })).status, 403);
  const route = { provider: 'synthetic', model: 'chat-window-model' };
  const resolved = await ctx.waterfall('agent/request', {}, async () => route);
  assert.equal(resolved, route);
  assert.equal((await rpc('status')).value.memory.model, 'chat-window-model');
  assert.deepEqual(calls[0].tools, []); assert.ok(!calls[0].messages.some(m => m.content[0].text.includes('此内容不得进入摘要')));
  const before = (await rpc('memory')).value;
  const saved = await rpc('memory-save', { text: '手动修订：偏好简洁中文', autoUpdate: false, expectedRevision: before.revision,
    modelSelection: { provider: 'synthetic', model: 'picked-summary' } });
  assert.equal(saved.ok, true);
  assert.equal((await rpc('status')).value.memory.model, 'picked-summary');
  assert.deepEqual((await db.call('readMemory')).modelSelection, { provider: 'synthetic', model: 'picked-summary' });
  assert.equal((await rpc('memory-save', { text: '旧窗口', autoUpdate: true, expectedRevision: before.revision })).error.code, 'MEMORY_CONFLICT');
  assert.equal((await rpc('memory', {}, { principal: { kind: 'guest' } })).status, 403);
  assert.equal((await rpc('memory-history', {}, { principal: { kind: 'guest' } })).status, 403);
  assert.equal((await rpc('memory-restore', { expectedRevision: 1, revision: 0 }, { principal: { kind: 'guest' } })).status, 403);
  const chat = ctx.sessions.create('summary-new-chat', { meta: { cwd: process.cwd() } });
  const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] });
  const signal = new AbortController().signal;
  const step = (session, messages, turn, stepNumber) => ctx.waterfall('agent/pre-step', {
    agent: { session }, messages, signal, turn, step: stepNumber,
  }, async () => ({ kind: 'enter', messages }));
  const result = await step(chat, [input], 1, 1);
  const summary = result.messages.find(m => m.source?.kind === 'history-rag-memory'); assert.ok(summary);
  assert.ok(summary.content[0].text.includes('手动修订'));
  const send = async session => {
    const call = await ctx.llm.prepareCall({ provider: 'synthetic', model: 'picked-summary', maxTokens: 32768 }, signal);
    const messages = Object.freeze(session.deriveMessages());
    for await (const _chunk of call.stream(Object.freeze({ ...call.config, messages, sessionId: session.id, signal }))) { /* drain */ }
    return calls.at(-1).messages;
  };
  const hasSummary = messages => messages.some(m => m.source?.kind === 'history-rag-memory');
  chat.append('system/message', { turn: 1, step: 1, message: createSystemMessage('系统提示') }, { surfaceOp: 'append' });
  for (const message of result.messages) chat.append('user/message', message, { surfaceOp: 'append' });
  assert.ok(hasSummary(await send(chat)));
  chat.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'synthetic', model: 'picked-summary' }, content: [{ type: 'text', text: '已回复' }],
  }) }, { surfaceOp: 'append' });
  await until(() => !hasSummary(chat.deriveMessages()));
  const wake = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: '定时唤醒' }] });
  const later = await step(chat, [wake], 2, 1);
  assert.deepEqual(later.messages, [wake]);
  chat.append('user/message', wake, { surfaceOp: 'append' });
  assert.ok(!hasSummary(await send(chat)));
  const snapshot = await ctx.sessionQuery.readSession(chat.id);
  const replayed = Session.create(chat.id, snapshot.events, snapshot.session, snapshot.inheritedEventCount);
  assert.ok(!hasSummary(await send(replayed)));
  assert.ok(snapshot.events.some(e => e.type === 'user/message' && e.data.id === summary.id));

  // Before an in-step retry (or overflow compaction), a prior summary must
  // already be gone by the time inner error handlers see the session.
  const retryChat = ctx.sessions.create('summary-retry');
  retryChat.append('user/message', input, { surfaceOp: 'append' });
  retryChat.append('user/message', summary, { surfaceOp: 'append' });
  await ctx.waterfall('agent/request-error', { agent: { session: retryChat }, turn: 1, step: 1, signal }, () => {
    assert.ok(!hasSummary(retryChat.deriveMessages()));
    return { kind: 'retry' };
  });
  assert.ok(!hasSummary(await send(retryChat)));
});

test('Native summary parser rejects incomplete model output and excludes reasoning blocks', async () => {
  const runtime = { config: { memoryMaxTokens: 1000 }, memory: {} };
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'test', model: 'test' }) }), llm: { async *stream() {
    yield { type: 'text-delta', index: 0, text: '不完整正文' }; yield { type: 'finish', reason: { kind: 'max-tokens' } };
  } } };
  await assert.rejects(hostSummarizer(ctx, runtime).generate({ previous: {}, chunks: [], maxChars: 100, signal: new AbortController().signal }), { code: 'SUMMARY_TRUNCATED' });
});

test('Native summary calls prefer a saved model, then actual chat routing, then the DSH default', async () => {
  const runtime = { config: { memoryMaxTokens: 1000 }, memory: { record: {} } };
  const calls = [];
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'default', model: 'default-chat' }) }), llm: { async *stream(options) {
    calls.push(options); yield { type: 'text-delta', index: 0, text: '摘要' }; yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const summary = hostSummarizer(ctx, runtime);
  const run = () => summary.generate({ previous: {}, chunks: [], maxChars: 100, signal: new AbortController().signal });
  await run();
  runtime.memory.lastTarget = { provider: 'chat', model: 'window-chat' }; await run();
  runtime.memory.record.modelSelection = { provider: 'configured', model: 'explicit-chat' }; await run();
  assert.deepEqual(calls.map(c => [c.provider, c.model]), [['default', 'default-chat'], ['chat', 'window-chat'], ['configured', 'explicit-chat']]);
  assert.ok(calls.every(c => !('apiKey' in c) && !('baseURL' in c)));
});

test('Native terminal failures retain the diagnostic code and status without exposing provider response text', async () => {
  const runtime = { config: { memoryMaxTokens: 1000 }, memory: {} };
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'test', model: 'test' }) }), llm: { async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', status: 429, message: 'private-provider-body-and-key' } } };
  } } };
  await assert.rejects(hostSummarizer(ctx, runtime).generate({ previous: {}, chunks: [], maxChars: 100, signal: new AbortController().signal }), error => {
    assert.equal(error.code, 'RATE_LIMITED'); assert.equal(error.status, 429);
    assert.ok(!error.message.includes('private-provider')); return true;
  });
});
