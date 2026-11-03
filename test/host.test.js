import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../lib/database.js';
import { EmbeddingClient } from '../lib/embedding.js';
import * as plugin from '../index.js';
import { tempConfig, track, until } from './helpers.js';

const sdkRoot = process.env.HISTORY_RAG_TEST_SDK;

test('Installed DSH SDK: plugin lifecycle, public session service, native pre-step waterfall and durable recall message', { skip: !sdkRoot }, async t => {
  const sdk = name => import(pathToFileURL(join(sdkRoot, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ Context }, { SessionStore }, { SessionQueryEngine }, { createUserMessage }] = await Promise.all([
    sdk('cordis'), sdk('dsh-session'), sdk('dsh-session-query'), sdk('dsh-llm'),
  ]);
  const config = await tempConfig(t);
  const ctx = new Context();
  // These are the installed host's real classes; no live user profile is loaded.
  new SessionStore(ctx); new SessionQueryEngine(ctx);
  ctx.provide('agents', {});
  const old = ctx.sessions.create('old-native', { meta: { cwd: process.cwd(), createdAt: 1 } });
  old.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '旧对话的蓝鲸部署口令是 sea-blue-42' }] }), { surfaceOp: 'append' });
  const chat = ctx.sessions.create('new-native', { meta: { cwd: process.cwd() } });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) }));
  };
  // Dispose the plugin before restoring the transport and deleting its SQLite.
  track(t, { close: async () => { await ctx.fiber.dispose(); globalThis.fetch = fetchBefore; } });
  const fiber = ctx.plugin(plugin, config);
  await fiber.await();
  const db = track(t, new Database(join(config.dataDir, 'history.sqlite')));
  const model = new EmbeddingClient(config).identity;
  await until(async () => (await db.call('status', model)).embeddedChunks === 1);
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '蓝鲸的部署口令是什么？' }] });
  const decision = { kind: 'enter', messages: [user] };
  const result = await ctx.waterfall('agent/pre-step', { agent: { session: chat }, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, async () => decision);
  assert.equal(result.messages.length, 2);
  assert.ok(result.messages[1].content[0].text.includes('sea-blue-42'));
  chat.append('user/message', result.messages[1], { surfaceOp: 'append' });
  const raw = await ctx.sessionQuery.readSession(chat.id);
  assert.equal(raw.events[0].data.source.form, 'recall');
  await until(async () => (await db.call('status', model)).chunks === 1);
});
