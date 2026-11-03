import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../lib/database.js';
import { EmbeddingClient } from '../lib/embedding.js';
import * as plugin from '../index.js';
import { tempConfig, track, until } from './helpers.js';

const sdkRoot = process.env.HISTORY_RAG_TEST_SDK;

test('Installed DSH: active tool registration, exact result schema, durable dedup, replay and compaction recovery', { skip: !sdkRoot }, async t => {
  const sdk = name => import(pathToFileURL(join(sdkRoot, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ Context }, { SessionStore, Session }, { SessionQueryEngine }, { createUserMessage, createToolResultMessage }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
    sdk('cordis'), sdk('dsh-session'), sdk('dsh-session-query'), sdk('dsh-llm'), sdk('dsh-system-prompt'), sdk('dsh-tools'),
  ]);
  const config = await tempConfig(t, { includeToolResults: true });
  const ctx = new Context();
  new SessionStore(ctx); new SessionQueryEngine(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' });
  ctx.provide('agents', {});
  const old = ctx.sessions.create('old-recall', { meta: { cwd: process.cwd(), createdAt: 1 } });
  old.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '蓝鲸部署端口 8181' }] }), { surfaceOp: 'append' });
  const chat = ctx.sessions.create('chat-recall', { meta: { cwd: process.cwd() } });
  const agent = { session: chat };
  const beforeFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Response(JSON.stringify({ data: JSON.parse(options.body).input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  track(t, { close: async () => { await ctx.fiber.dispose(); globalThis.fetch = beforeFetch; } });
  const fiber = ctx.plugin(plugin, config);
  await fiber.await();
  await until(() => Boolean(ctx.tools.get('history_recall')));
  assert.ok(ctx.tools.schemas().some(schema => schema.name === 'history_recall'));
  const db = track(t, new Database(join(config.dataDir, 'history.sqlite')));
  const model = new EmbeddingClient(config).identity;
  await until(async () => (await db.call('status', model)).embeddedChunks === 1);
  const execute = mode => ctx.tools.execute({ callId: `recall-${mode}`, name: 'history_recall', arguments: { query: '蓝鲸', mode }, agent, signal: new AbortController().signal });
  const result = await execute('keyword');
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.hits[0].text, '蓝鲸部署端口 8181');
  assert.equal(result.meta.historyRagRecall, true);
  const toolEvent = chat.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: 'recall-keyword', content: result.content, isError: result.isError }), meta: result.meta }, { surfaceOp: 'append' });
  assert.equal((await execute('embedding')).value.hits.length, 0);
  const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '蓝鲸的部署端口' }] });
  const preStep = () => ctx.waterfall('agent/pre-step', { agent, messages: [input], turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [input] }));
  assert.equal((await preStep()).messages.length, 1);
  const raw = await ctx.sessionQuery.readSession(chat.id);
  agent.session = Session.create(chat.id, raw.events, raw.session, raw.inheritedEventCount);
  assert.equal((await preStep()).messages.length, 1);
  agent.session = chat;
  chat.append('user/message', createUserMessage({ source: { kind: 'compaction' }, content: [{ type: 'text', text: '较早的工具结果已压缩' }] }),
    { surfaceOp: { op: 'replace', startSeq: toolEvent.seq, endSeq: toolEvent.seq }, sourceEventSeqs: [toolEvent.seq] });
  const fresh = await preStep();
  assert.equal(fresh.messages.length, 2);
  assert.ok(fresh.messages[1].content[0].text.includes('蓝鲸部署端口 8181'));
  const injected = chat.append('user/message', fresh.messages[1], { surfaceOp: 'append' });
  assert.equal((await preStep()).messages.length, 1);
  chat.append('user/message', createUserMessage({ source: { kind: 'compaction' }, content: [{ type: 'text', text: '较早的召回原文已压缩' }] }),
    { surfaceOp: { op: 'replace', startSeq: injected.seq, endSeq: injected.seq }, sourceEventSeqs: [injected.seq] });
  assert.equal((await execute('embedding')).value.hits.length, 1);
  await until(async () => (await db.call('status', model)).chunks === 1);
  await fiber.dispose();
  assert.equal(ctx.tools.get('history_recall'), undefined);
});
