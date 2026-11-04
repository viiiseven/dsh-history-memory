import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.js';
import { tempConfig, track, until } from './helpers.js';

const sdkRoot = process.env.HISTORY_RAG_TEST_SDK;
test('Native DSH tool execution only accepts a fresh explicit human request and revokes it next turn', { skip: !sdkRoot }, async t => {
  const sdk = name => import(pathToFileURL(join(sdkRoot, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ Context }, { SessionStore }, { SessionQueryEngine }, { createUserMessage }, { SystemPrompt }, { ToolRuntime }] = await Promise.all([
    sdk('cordis'), sdk('dsh-session'), sdk('dsh-session-query'), sdk('dsh-llm'), sdk('dsh-system-prompt'), sdk('dsh-tools'),
  ]);
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '', updateCheckEnabled: false });
  const ctx = new Context(); new SessionStore(ctx); new SessionQueryEngine(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' });
  ctx.provide('agents', {}); track(t, { close: () => ctx.fiber.dispose() });
  const fiber = ctx.plugin(plugin, config); await fiber.await();
  await until(() => Boolean(ctx.tools.get('history_memory_edit')));
  const agent = { session: ctx.sessions.create('explicit-memory-native') }, signal = new AbortController().signal;
  const enter = async (text, turn, kind = 'user') => {
    const messages = [createUserMessage({ source: { kind }, content: [{ type: 'text', text }] })];
    return ctx.waterfall('agent/pre-step', { agent, messages, turn, step: 1, signal }, async () => ({ kind: 'enter', messages }));
  };
  let counter = 0;
  const execute = args => ctx.tools.execute({ callId: `memory-${counter++}`, name: 'history_memory_edit', arguments: args, agent, signal });
  await enter('我喜欢中文', 1); assert.equal((await execute({ action: 'read' })).isError, true);
  await enter('请记住：用户偏好中文', 2);
  const first = await execute({ action: 'read' }); assert.equal(first.isError, false, JSON.stringify(first));
  const saved = await execute({ action: 'edit', expectedRevision: first.value.revision, authorization: first.value.authorization,
    operations: [{ op: 'add', text: '用户偏好中文' }] });
  assert.equal(saved.isError, false, JSON.stringify(saved)); assert.equal(saved.value.text, '用户偏好中文');
  assert.equal(saved.meta.historyRagMemory, true);
  assert.equal((await execute({ action: 'read' })).isError, true);
  await enter('请记住：定时唤醒不能授权', 3, 'schedule'); assert.equal((await execute({ action: 'read' })).isError, true);
  await enter('请记住：下一个事实', 4); assert.equal((await execute({ action: 'read' })).isError, false);
  await enter('只是随便聊聊', 5); assert.equal((await execute({ action: 'read' })).isError, true);
  await fiber.dispose(); assert.equal(ctx.tools.get('history_memory_edit'), undefined);
});
