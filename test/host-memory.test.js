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
  const [{ Context }, { SessionStore }, { SessionQueryEngine }, { HostConnectionService }, { LlmRuntime, LlmAdapter, createUserMessage }] = await Promise.all([
    sdk('cordis'), sdk('dsh-session'), sdk('dsh-session-query'), sdk('dsh-client-connection'), sdk('dsh-llm'),
  ]);
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '', memoryDebounceMs: 0 });
  const ctx = new Context(); new SessionStore(ctx); new SessionQueryEngine(ctx); new HostConnectionService(ctx, [], { isAuthenticated: () => true }); new LlmRuntime(ctx);
  ctx.provide('agents', {}); ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'native-summary' }) });
  const calls = [];
  class Adapter extends LlmAdapter {
    async *stream(options) {
      calls.push(options);
      yield { type: 'reasoning-delta', index: 0, text: '此内容不得进入摘要' };
      yield { type: 'text-delta', index: 1, text: '用户偏好中文。' };
      yield { type: 'block-end', index: 1, block: { type: 'text', text: '用户偏好中文。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['synthetic'], new Adapter());
  const old = ctx.sessions.create('summary-original', { meta: { cwd: process.cwd(), createdAt: 1 } });
  old.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '我喜欢用中文聊天' }] }), { surfaceOp: 'append' });
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
  assert.deepEqual(calls[0].tools, []); assert.ok(!calls[0].messages.some(m => m.content[0].text.includes('此内容不得进入摘要')));
  const before = (await rpc('memory')).value;
  const saved = await rpc('memory-save', { text: '手动修订：偏好简洁中文', autoUpdate: false, expectedRevision: before.revision });
  assert.equal(saved.ok, true);
  assert.equal((await rpc('memory-save', { text: '旧窗口', autoUpdate: true, expectedRevision: before.revision })).error.code, 'MEMORY_CONFLICT');
  assert.equal((await rpc('memory', {}, { principal: { kind: 'guest' } })).status, 403);
  const chat = ctx.sessions.create('summary-new-chat', { meta: { cwd: process.cwd() } });
  const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] });
  const result = await ctx.waterfall('agent/pre-step', { agent: { session: chat }, messages: [input], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [input] }));
  const summary = result.messages.find(m => m.source?.kind === 'history-rag-memory'); assert.ok(summary);
  assert.ok(summary.content[0].text.includes('手动修订'));
  chat.append('user/message', summary, { surfaceOp: 'append' });
  await until(async () => (await db.call('memoryCounts')).total === 1);
});

test('Native summary parser rejects incomplete model output and excludes reasoning blocks', async () => {
  const runtime = { config: { memoryMaxTokens: 1000 }, memory: {} };
  const ctx = { get: () => ({ currentSelection: () => ({ provider: 'test', model: 'test' }) }), llm: { async *stream() {
    yield { type: 'text-delta', index: 0, text: '不完整正文' }; yield { type: 'finish', reason: { kind: 'max-tokens' } };
  } } };
  await assert.rejects(hostSummarizer(ctx, runtime).generate({ previous: {}, chunks: [], maxChars: 100, signal: new AbortController().signal }), { code: 'SUMMARY_TRUNCATED' });
});
