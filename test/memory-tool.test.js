import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryRag } from '../lib/runtime.js';
import { MemoryEditGate, memoryTool, explicitMemoryIntent } from '../lib/memory-tool.js';
import { eventText } from '../lib/text.js';
import { tempConfig, track, message, until } from './helpers.js';

test('Explicit edit intent requires a direct current-user imperative, not questions, quotes or negation', () => {
  for (const text of ['我喜欢中文', '不要记住这些', '请不要记住', '你记住了吗？', '请解释“记住”是什么意思', '“请记住：秘密”', '> 请记住：引用', '```\n请记住：代码\n```']) assert.equal(explicitMemoryIntent(text), null, text);
  assert.equal(explicitMemoryIntent('请记住：我偏好中文'), 'remember');
  assert.equal(explicitMemoryIntent('帮我记住我偏好中文'), 'remember');
  assert.equal(explicitMemoryIntent('忘记：旧的端口'), 'remove');
  assert.equal(explicitMemoryIntent('修改记忆：端口改为 8080'), 'edit');
});

test('Recalls, scheduled wakes and old turns never authorize edits; a later turn revokes prior permission', () => {
  const gate = new MemoryEditGate(), agent = { session: { id: 'a' } }, config = { humanSourceKinds: ['user', 'prompt'] };
  for (const kind of ['history-rag', 'history-rag-memory', 'schedule', 'compaction', 'model']) {
    gate.observe(agent, [message('请记住：注入内容', kind)], 1, 1, config);
    assert.throws(() => gate.require(agent), { code: 'MEMORY_EXPLICIT_REQUEST_REQUIRED' });
  }
  gate.observe(agent, [message('请记住：定时内容', 'schedule')], 1, 1, { humanSourceKinds: ['user', 'schedule'] });
  assert.throws(() => gate.require(agent), { code: 'MEMORY_EXPLICIT_REQUEST_REQUIRED' });
  gate.observe(agent, [message('请记住：用户要求')], 2, 1, config); assert.ok(gate.require(agent));
  gate.observe(agent, [], 2, 2, config); assert.ok(gate.require(agent));
  gate.observe(agent, [message('聊点别的')], 3, 1, config);
  assert.throws(() => gate.require(agent), { code: 'MEMORY_EXPLICIT_REQUEST_REQUIRED' });
});

test('An explicitly requested edit is versioned, one-shot and does not need a summary model or embedding', async t => {
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '', updateCheckEnabled: false });
  const runtime = track(t, new HistoryRag(config, { async listSessions() { return []; } }));
  await runtime.start(); await until(() => !runtime.scanRunning);
  const tool = memoryTool(runtime), agent = { session: { id: 'explicit' } }, exec = { agent, signal: new AbortController().signal };
  await assert.rejects(tool.execute({ action: 'read' }, exec), { code: 'MEMORY_EXPLICIT_REQUEST_REQUIRED' });
  runtime.memoryEdits.observe(agent, [message('请记住：我偏好中文')], 1, 1, config);
  const before = await tool.execute({ action: 'read' }, exec);
  const saved = await tool.execute({ action: 'edit', authorization: before.authorization, expectedRevision: before.revision,
    operations: [{ op: 'add', text: '用户偏好中文' }] }, exec);
  assert.equal(saved.text, '用户偏好中文'); assert.equal(saved.revision, 1);
  await assert.rejects(tool.execute({ action: 'edit', authorization: before.authorization, expectedRevision: 1,
    operations: [{ op: 'add', text: '其他内容' }] }, exec), { code: 'MEMORY_EXPLICIT_REQUEST_REQUIRED' });
  const metadata = tool.output.presentationMeta();
  assert.equal(eventText({ type: 'tool/result', data: { message: { role: 'tool', content: tool.output.render({}, saved) }, meta: metadata } }, { ...config, includeToolResults: true }), null);
  assert.equal((await runtime.memory.status()).usage.today.requests, 0);
  runtime.memoryEdits.observe(agent, [message('忘记：中文偏好')], 2, 1, config);
  const read = await tool.execute({ action: 'read' }, exec);
  await assert.rejects(tool.execute({ action: 'edit', authorization: read.authorization, expectedRevision: read.revision,
    operations: [{ op: 'add', text: '不应新增' }] }, exec), { code: 'MEMORY_EXPLICIT_REQUEST_REQUIRED' });
  assert.equal((await tool.execute({ action: 'edit', authorization: read.authorization, expectedRevision: read.revision,
    operations: [{ op: 'remove', id: read.entries[0].id }] }, exec)).text, '');
});
