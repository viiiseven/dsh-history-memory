import test from 'node:test';
import assert from 'node:assert/strict';
import { recallMessage, preStep } from '../lib/recall.js';
import { recallContext, visibleRecallRefs } from '../lib/context.js';
import { recallTool, toolResult, toolText } from '../lib/tool.js';
import { chunksFromSnapshot, eventText, hash } from '../lib/text.js';
import { HistoryRag } from '../lib/runtime.js';
import { tempConfig, snapshot, message, track, until, fakeClient } from './helpers.js';

function hit(text, index = 0) {
  return { id: `s:${index}:0`, sessionId: 's', seq: index, part: 0, role: 'user', time: 1, cwd: 'A', text, hash: hash(text), score: 0.9 };
}

test('Recall references include only actually delivered chunks and survive JSON replay', () => {
  const hits = [hit('第一条原文'.repeat(180)), hit('第二条原文'.repeat(180), 1)];
  const injected = recallMessage(hits, 800);
  const replay = JSON.parse(JSON.stringify(injected));
  assert.equal(visibleRecallRefs(replay).length, 1);
  assert.equal(visibleRecallRefs(replay)[0].hash, hits[0].hash);
  replay.content[0].text = '压缩后的摘要';
  assert.deepEqual(visibleRecallRefs(replay), []);
});

test('Existing v0.2 full original-text injections are recognized without treating a partial legacy fragment as fully seen', () => {
  const injected = JSON.parse(JSON.stringify(recallMessage([hit('原话\n保留换行\n与全部标点。')], 6000)));
  delete injected.source.recallRefs; delete injected.source.recallBodyHash;
  assert.deepEqual(visibleRecallRefs(injected), [{ id: 's:0:0', hash: hash('原话\n保留换行\n与全部标点。') }]);
  const partial = JSON.parse(JSON.stringify(recallMessage([hit('长原话'.repeat(1000))], 600)));
  delete partial.source.recallRefs; delete partial.source.recallBodyHash;
  assert.deepEqual(visibleRecallRefs(partial), []);
});

test('Tool original-text results and Code Mode wrappers participate in current-context deduplication', () => {
  const value = toolResult([hit('工具找回的原文 😀')], 'keyword', 6000);
  const toolMessage = { role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: `日志\n${toolText(value)}\n结束` }] };
  assert.equal(visibleRecallRefs(toolMessage)[0].hash, hash('工具找回的原文 😀'));
  const agent = { session: { id: 'chat', surface: { nodes: [2] }, deriveMessages: () => [toolMessage] } };
  assert.deepEqual(recallContext(agent).excludeHashes, [hash('工具找回的原文 😀')]);
  toolMessage.content[0].text = '工具结果已压缩';
  assert.deepEqual(recallContext(agent).excludeHashes, []);
});

test('Active recall returns bounded original text and does not reindex its own tool responses', async t => {
  const config = await tempConfig(t, { includeToolResults: true });
  const value = toolResult([hit('😀原始文本'.repeat(2000))], 'keyword', 700);
  assert.ok(toolText(value).length <= 700); assert.ok(value.hits[0].truncated);
  const toolMessage = { role: 'tool', content: [{ type: 'text', text: toolText(value) }], source: { kind: 'tool' } };
  assert.equal(visibleRecallRefs(toolMessage).length, 1);
  assert.equal(eventText({ type: 'tool/result', data: { message: toolMessage } }, config), null);
  value.hits[0].text = '只剩下摘要';
  toolMessage.content[0].text = toolText(value);
  assert.deepEqual(visibleRecallRefs(toolMessage), []);
});

test('Deduplication happens before top-3 ranking, and removing visible recall permits it again', async t => {
  const config = await tempConfig(t);
  assert.equal(config.topK, 3);
  const data = snapshot('past', ['蓝鲸记录一', '蓝鲸记录二', '蓝鲸记录三', '蓝鲸记录四']);
  const runtime = track(t, new HistoryRag(config, { async listSessions() { return [{ header: data.session }]; }, async readSession() { return data; } }, { client: fakeClient() }));
  await runtime.start(); await until(async () => (await runtime.status()).coverage === 1);
  const visible = [];
  const agent = { session: { id: 'chat', header: { cwd: 'A' }, surface: { nodes: [] }, deriveMessages: () => visible } };
  const input = message('蓝鲸');
  const run = () => preStep(runtime)({ agent, messages: [input] }, async () => ({ kind: 'enter', messages: [input] }));
  const first = await run();
  assert.equal(first.messages[1].source.recallRefs.length, 3);
  visible.push(first.messages[1]);
  const second = await run();
  assert.equal(second.messages[1].source.recallRefs.length, 1);
  visible.push(second.messages[1]);
  assert.equal((await run()).messages.length, 1);
  visible.splice(0, 1);
  const afterCompression = await run();
  assert.equal(afterCompression.messages[1].source.recallRefs.length, 3);
});

test('Keyword recall works with no Embedding and supports short Chinese, case-insensitive AND terms and literal symbols', async t => {
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '' });
  const data = snapshot('past', ['部署端口为 8181，配置项 API_KEY', '部署端口为 9000', 'API_KEY 其他地方', '符号 %_ 按字面处理']);
  const runtime = track(t, new HistoryRag(config, { async listSessions() { return [{ header: data.session }]; }, async readSession() { return data; } }));
  await runtime.start(); await until(async () => (await runtime.status()).chunks === 4);
  const tool = recallTool(runtime), exec = { signal: new AbortController().signal };
  const result = await tool.execute({ query: '部署 api_key', mode: 'keyword' }, exec);
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].text, data.events[0].data.content[0].text);
  assert.equal((await tool.execute({ query: '%_', mode: 'keyword' }, exec)).hits.length, 1);
  assert.equal((await tool.execute({ query: '端口', mode: 'keyword' }, exec)).hits.length, 2);
  await assert.rejects(tool.execute({ query: '部署', mode: 'embedding' }, exec), /keyword/);
  await assert.rejects(tool.execute({ query: ' ', mode: 'keyword' }, exec), /非空/);
});

test('Both active search modes respect visible chunks, source exclusions and the configured workspace', async t => {
  const config = await tempConfig(t, { scope: 'workspace' });
  const a = snapshot('a', ['蓝鲸目标'], 'A'), b = snapshot('b', ['蓝鲸外部'], 'B');
  const runtime = track(t, new HistoryRag(config, { async listSessions() { return [a, b].map(s => ({ header: s.session })); }, async readSession(id) { return id === 'a' ? a : b; } }, { client: fakeClient() }));
  await runtime.start(); await until(async () => (await runtime.status()).coverage === 1);
  const original = chunksFromSnapshot(a, config)[0];
  const visible = [recallMessage([{ ...original, score: 1 }], 6000)];
  const exec = { agent: { session: { header: { cwd: 'A' }, surface: { nodes: [] }, deriveMessages: () => visible } }, signal: new AbortController().signal };
  const tool = recallTool(runtime);
  for (const mode of ['keyword', 'embedding']) assert.deepEqual((await tool.execute({ query: '蓝鲸', mode }, exec)).hits, []);
  visible.length = 0;
  for (const mode of ['keyword', 'embedding']) assert.equal((await tool.execute({ query: '蓝鲸', mode }, exec)).hits[0].sessionId, 'a');
});

test('Active keyword search honors a pre-aborted execution signal', async t => {
  const config = await tempConfig(t);
  const runtime = track(t, new HistoryRag(config, { async listSessions() { return []; } }));
  const stop = new AbortController(); stop.abort(new Error('cancelled'));
  await assert.rejects(recallTool(runtime).execute({ query: '蓝鲸', mode: 'keyword' }, { signal: stop.signal }), /cancelled/);
});
