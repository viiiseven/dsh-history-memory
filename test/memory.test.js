import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryRag } from '../lib/runtime.js';
import { preStep } from '../lib/recall.js';
import { eventText } from '../lib/text.js';
import { applyMemoryPatch, parsePatch } from '../lib/memory-document.js';
import { tempConfig, snapshot, message, track, until } from './helpers.js';

async function setup(t, overrides = {}, runtimeOptions = {}) {
  const config = await tempConfig(t, { embeddingEndpoint: '', embeddingModel: '', memoryDebounceMs: 0, memoryIntervalMs: 1000,
    memoryTriggerTokens: 0, memoryMaxWaitMs: 0, updateCheckEnabled: false, ...overrides });
  const sessions = new Map([['a', snapshot('a', ['偏好使用中文回复', '项目 A 使用端口 8181'])]]);
  const source = { async listSessions() { return [...sessions.values()].map(s => ({ header: s.session })); }, async readSession(id) { return sessions.get(id); } };
  const runtime = track(t, new HistoryRag(config, source, runtimeOptions)); await runtime.start();
  await until(() => !runtime.pumpRunning && !runtime.scanRunning);
  return { runtime, config, sessions, source };
}
const generator = generate => ({ selection: () => ({ provider: 'synthetic', model: 'summary-model' }), generate });
const add = (input, text) => ({ operations: [{ op: 'add', text, sources: [input.batch.additions[0].id] }] });
const update = (input, text) => input.previous.entries.length
  ? { operations: [{ op: 'replace', id: input.previous.entries[0].id, text, sources: [input.batch.additions[0].id] }] } : add(input, text);
async function runManual(runtime) {
  runtime.memory.requestUpdate(); await until(() => !runtime.memory.running && !runtime.memory.checking && !runtime.memory.force, 15000);
}
async function rescan(runtime) { await runtime.scan(); await until(() => !runtime.pumpRunning && !runtime.scanRunning); }

test('Only changed memory is generated; unchanged entries and receipts survive restart', async t => {
  const { runtime, sessions, config, source } = await setup(t);
  const calls = [];
  runtime.memory.setGenerator(generator(async input => { calls.push(input); return update(input, calls.length === 1 ? '偏好中文，项目端口 8181。' : '偏好中文，项目端口 8282。'); }));
  await runtime.memory.kick();
  assert.equal(calls[0].batch.additions.length, 2); assert.equal((await runtime.memory.status()).pending, 0);
  const id = (await runtime.memory.read()).entries[0].id;
  sessions.set('b', snapshot('b', ['项目 A 现在改为端口 8282'])); await rescan(runtime); await runManual(runtime);
  assert.equal(calls[1].batch.additions.length, 1); assert.equal(calls[1].previous.entries[0].id, id);
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start();
  assert.equal((await reopened.memory.read()).text, '偏好中文，项目端口 8282。');
  assert.equal((await reopened.memory.status()).pending, 0);
  reopened.memory.setGenerator(generator(async () => { throw new Error('No new content'); }));
  await reopened.memory.kick(); assert.equal(reopened.memory.lastError, null);
});

test('A no-change result advances receipts without rewriting text or creating a new revision', async t => {
  const { runtime } = await setup(t);
  await runtime.memory.save({ text: '手动的既有记忆', autoUpdate: true, expectedRevision: 0 });
  runtime.memory.setGenerator(generator(async () => ({ operations: [] })));
  await runtime.memory.kick();
  const record = await runtime.memory.read();
  assert.equal(record.revision, 1); assert.equal(record.text, '手动的既有记忆');
  assert.equal((await runtime.memory.status()).pending, 0);
});

test('Manual editing aborts outstanding work and rejects stale windows without losing pending sources', async t => {
  const { runtime } = await setup(t);
  let finish, input;
  runtime.memory.setGenerator(generator(async value => { input = value; return new Promise(resolve => { finish = resolve; }); }));
  const pending = runtime.memory.kick(); await until(() => Boolean(finish));
  await runtime.memory.save({ text: '用户修订', autoUpdate: false, expectedRevision: 0 });
  finish(add(input, '过时输出')); await pending;
  assert.equal((await runtime.memory.read()).text, '用户修订'); assert.equal((await runtime.memory.status()).pending, 2);
  await assert.rejects(runtime.memory.save({ text: '过期编辑', autoUpdate: false, expectedRevision: 0 }), { code: 'MEMORY_CONFLICT' });
  runtime.memory.setGenerator(generator(async input => {
    if (input.phase === 'compact') return { operations: [] };
    assert.equal(input.previous.text, '用户修订'); return add(input, '原文中的其他信息');
  }));
  await runManual(runtime);
  assert.equal((await runtime.memory.read()).text, '用户修订\n\n原文中的其他信息');
});

test('Small updates accumulate until the oldest pending deadline; a manual update bypasses waiting', async t => {
  const { runtime } = await setup(t, { memoryTriggerTokens: 6000, memoryMaxWaitMs: 600000 });
  let calls = 0;
  runtime.memory.setGenerator(generator(async () => { calls++; return { operations: [] }; }));
  await runtime.memory.kick(); assert.equal(calls, 0);
  runtime.memory.lastDirtyAt = 0; await runtime.memory.kick(); assert.equal(calls, 0);
  runtime.reconfigure({ ...runtime.config, memoryMaxWaitMs: 0 });
  await runtime.memory.kick(); assert.equal(calls, 1);
  assert.equal((await runtime.memory.status()).pending, 0);
});

test('One manual run drains 2,000 sessions in bounded token batches, without inter-batch intervals', async t => {
  const { runtime, sessions } = await setup(t, { memoryIntervalMs: 60000, memoryTriggerTokens: 6000, memoryMaxWaitMs: 600000 });
  for (let i = 1; i < 2000; i++) sessions.set(`chat-${i}`, snapshot(`chat-${i}`, [`历史会话 ${i}`]));
  await rescan(runtime);
  const ids = new Set(), sizes = [];
  runtime.memory.setGenerator(generator(async input => {
    if (input.phase === 'compact') return { operations: [] };
    for (const addition of input.batch.additions) { assert.ok(!ids.has(addition.id)); ids.add(addition.id); }
    sizes.push(input.batch.additions.length);
    assert.ok(input.batch.estimatedTokens <= 10000);
    return update(input, `已检查 ${ids.size} 条消息`);
  }));
  await runManual(runtime);
  assert.equal(ids.size, 2001); assert.ok(sizes.length < 100, `batches=${sizes.length}`);
  assert.equal((await runtime.memory.status()).pending, 0);
  assert.equal((await runtime.memory.read()).text, '已检查 2001 条消息');
});

test('Long messages are read in source order without RAG overlaps or missing ranges', async t => {
  const { runtime, sessions } = await setup(t, { memoryBatchTokens: 600 });
  const text = Array.from({ length: 250 }, (_, i) => `段落 ${i} 的唯一内容。\n`).join('');
  sessions.set('a', snapshot('a', [text])); await rescan(runtime);
  const seen = []; let contextSeen = false;
  runtime.memory.setGenerator(generator(async input => {
    for (const source of input.batch.additions) seen.push(source);
    contextSeen ||= input.batch.context.length > 0;
    return { operations: [] };
  }));
  await runtime.memory.kick();
  assert.ok(seen.length > 1, JSON.stringify({ batches: seen.length, error: runtime.memory.lastError })); assert.ok(contextSeen);
  assert.equal(seen.map(source => source.text).join(''), text);
  assert.ok(seen.every((source, index) => source.start === (index ? seen[index - 1].end : 0)));
  assert.equal((await runtime.memory.status()).pending, 0);
});

test('Capacity compaction only sees staged memory, and never resends the source batch', async t => {
  const { runtime } = await setup(t, { memoryMaxChars: 256 });
  const calls = [];
  runtime.memory.setGenerator(generator(async input => {
    calls.push(input);
    return input.phase === 'update' ? add(input, '较长记忆'.repeat(70))
      : { operations: [{ op: 'replace', id: input.previous.entries[0].id, text: '精简的有效记忆', sources: [] }] };
  }));
  await runtime.memory.kick();
  assert.equal(calls.length, 2); assert.equal(calls[1].batch.additions.length, 0);
  assert.equal((await runtime.memory.read()).text, '精简的有效记忆'); assert.equal((await runtime.memory.status()).pending, 0);
});

test('Every growing update consolidates duplicates below capacity, including when already above 85%', async t => {
  for (const original of ['偏好中文。', '保留的有效记忆'.repeat(120)]) {
    const { runtime, sessions } = await setup(t, { memoryMaxChars: 1024 });
    const calls = [];
    runtime.memory.setGenerator(generator(input => {
      calls.push(input);
      if (input.phase === 'compact') {
        assert.deepEqual(input.batch, { additions: [], context: [] });
        return { operations: [{ op: 'remove', id: input.previous.entries.at(-1).id, sources: [] }] };
      }
      return add(input, input.previous.entries.length ? '另一种说法重复既有信息。' : original);
    }));
    await runtime.memory.kick();
    sessions.set('b', snapshot('b', ['同一事实再次出现'])); await rescan(runtime); await runManual(runtime);
    assert.deepEqual(calls.map(call => call.phase), ['update', 'update', 'compact']);
    assert.equal((await runtime.memory.read()).text, original);
    assert.equal((await runtime.memory.status()).pending, 0);
    await runtime.close();
  }
});

test('No-op, exact duplicates and shrinking updates spend no separate compaction request', async t => {
  const { runtime, sessions } = await setup(t);
  const phases = []; let stage = 0;
  runtime.memory.setGenerator(generator(input => {
    phases.push(input.phase); assert.equal(input.phase, 'update');
    if (stage === 0 || stage === 2) return add(input, '偏好简洁的中文回答。');
    if (stage === 1) return { operations: [] };
    return update(input, '偏好中文。');
  }));
  await runtime.memory.kick();
  for (stage = 1; stage <= 3; stage++) {
    sessions.set(`b${stage}`, snapshot(`b${stage}`, [`增量原文 ${stage}`])); await rescan(runtime); await runManual(runtime);
  }
  assert.deepEqual(phases, Array(4).fill('update'));
  assert.equal((await runtime.memory.read()).text, '偏好中文。');
});

test('A compaction patch cannot expand the summary or bypass manual/locked protection', () => {
  const entry = { id: 'one', text: '简短记忆', locked: false, protectedAt: 0, sources: [] };
  const patch = { operations: [{ op: 'replace', id: 'one', text: '反而写出了更长的重复记忆', sources: [] }] };
  assert.throws(() => applyMemoryPatch([entry], patch, [], { compact: true }), { code: 'SUMMARY_INVALID_PATCH' });
  const remove = { operations: [{ op: 'remove', id: 'one', sources: [] }] };
  assert.throws(() => applyMemoryPatch([{ ...entry, locked: true }], remove, [], { compact: true }), { code: 'SUMMARY_LOCKED' });
  assert.throws(() => applyMemoryPatch([{ ...entry, protectedAt: 1 }], remove, [], { compact: true }), { code: 'SUMMARY_PROTECTED' });
});

test('Archiving or deleting a source during generation rejects its result before compaction/commit', async t => {
  for (const action of ['archive', 'delete']) {
    const archived = new Set();
    const { runtime, sessions } = await setup(t, {}, { archivedSessionIds: () => [...archived] });
    await runtime.memory.save({ text: '已保存摘要不受影响', autoUpdate: true, expectedRevision: 0 });
    let finish, calls = 0;
    runtime.memory.setGenerator(generator(input => {
      calls++; return new Promise(resolve => { finish = () => resolve(add(input, '过期输入不能写入')); });
    }));
    const running = runtime.memory.kick(); await until(() => Boolean(finish));
    if (action === 'archive') archived.add('a');
    else { sessions.delete('a'); await rescan(runtime); }
    finish(); await running;
    assert.equal(calls, 1); assert.equal((await runtime.memory.read()).text, '已保存摘要不受影响');
    assert.equal((await runtime.memory.status()).pending, 0);
    assert.equal(runtime.memory.work, null);
    await runtime.close();
  }
});

test('Unfit staged changes persist across restart and fit a raised capacity without another paid request', async t => {
  const { runtime, config, source } = await setup(t, { memoryMaxChars: 256 });
  let calls = 0;
  const fake = generator(async input => { calls++; return input.phase === 'update' ? add(input, '长'.repeat(300)) : { operations: [] }; });
  runtime.memory.setGenerator(fake); await runtime.memory.kick(); assert.equal(calls, 2);
  assert.equal(runtime.memory.lastError.code, 'SUMMARY_CAPACITY'); assert.equal((await runtime.memory.status()).pending, 2);
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start(); await rescan(reopened);
  reopened.memory.setGenerator(fake); await reopened.memory.kick(); assert.equal(calls, 2);
  const record = await reopened.memory.read();
  await reopened.memory.save({ text: record.text, autoUpdate: true, expectedRevision: record.revision, preferences: { memoryMaxChars: 512 } });
  await runManual(reopened);
  assert.equal(calls, 2); assert.equal((await reopened.memory.read()).text, '长'.repeat(300));
  assert.equal((await reopened.memory.status()).pending, 0);
});

test('Malformed output and truncation never retry automatically after restart or incoming new data', async t => {
  for (const code of ['SUMMARY_INVALID_PATCH', 'SUMMARY_TRUNCATED']) {
    const { runtime, config, source, sessions } = await setup(t);
    let calls = 0;
    const fake = generator(async () => { calls++; if (code === 'SUMMARY_TRUNCATED') throw Object.assign(new Error('private'), { code }); return 'invalid json'; });
    runtime.memory.setGenerator(fake); await runtime.memory.kick(); assert.equal(calls, 1);
    await runtime.close();
    const reopened = track(t, new HistoryRag(config, source)); await reopened.start(); await rescan(reopened);
    sessions.set('b', snapshot('b', ['新增消息不应解锁同一失败批次'])); await rescan(reopened);
    reopened.memory.setGenerator(fake); await reopened.memory.kick();
    assert.equal(calls, 1); assert.equal(reopened.memory.lastError.code, code);
    await runManual(reopened); assert.equal(calls, 2);
    await reopened.close();
  }
});

test('Transient retries are bounded, durable and preserve earlier committed batches', async t => {
  const { runtime, config, source, sessions } = await setup(t, { memoryBatchTokens: 256, memoryRetryLimit: 1 });
  sessions.set('a', snapshot('a', Array.from({ length: 10 }, (_, i) => `原文 ${i}。`))); await rescan(runtime);
  let calls = 0;
  const fake = generator(async input => {
    calls++;
    if (calls > 1) throw Object.assign(new Error('private-body'), { code: 'RATE_LIMITED', status: 429 });
    return add(input, '首批保存');
  });
  runtime.memory.setGenerator(fake); await runtime.memory.kick();
  assert.equal(calls, 2); assert.ok(runtime.memory.retryAt > Date.now());
  const pending = (await runtime.memory.status()).pending; assert.ok(pending > 0 && pending < 10);
  runtime.memory.work.retryAt = 0; runtime.memory.work.failure = null; await runtime.memory.persistWork();
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start(); await rescan(reopened);
  reopened.memory.setGenerator(fake); await reopened.memory.kick();
  assert.equal(calls, 3); assert.equal(reopened.memory.retryAt, 0);
  reopened.memory.lastRunAt = 0; await reopened.memory.kick(); assert.equal(calls, 3);
  assert.equal((await reopened.memory.read()).text, '首批保存');
  assert.ok(!JSON.stringify(await reopened.memory.status()).includes('private-body'));
});

test('Usage includes failed requests, details are not double-counted and absent usage reserves budget', async t => {
  const { runtime } = await setup(t);
  runtime.memory.setGenerator(generator(async ({ onUsage }) => {
    onUsage({ inputTokens: 100, outputTokens: 60, totalTokens: 160, reasoningTokens: 40, cacheReadTokens: 20 });
    throw Object.assign(new Error('max'), { code: 'SUMMARY_TRUNCATED' });
  }));
  await runtime.memory.kick();
  let usage = (await runtime.memory.status()).usage.today;
  assert.equal(usage.requests, 1); assert.equal(usage.failures, 1); assert.equal(usage.budgetTokens, 160);
  assert.equal(usage.reasoningTokens, 40); assert.equal(usage.cacheReadTokens, 20);
  runtime.memory.setGenerator(generator(async () => ({ operations: [] }))); await runManual(runtime);
  usage = (await runtime.memory.status()).usage.today;
  assert.equal(usage.requests, 2); assert.equal(usage.unknownRequests, 1); assert.ok(usage.budgetTokens > 32768);
});

test('Daily caps prevent starting a request and manual updates cannot bypass the cap', async t => {
  const { runtime } = await setup(t, { memoryDailyTokens: 100 }); let calls = 0;
  runtime.memory.setGenerator(generator(async () => { calls++; return { operations: [] }; }));
  await runtime.memory.kick(); await runManual(runtime);
  assert.equal(calls, 0); assert.equal(runtime.memory.lastError.code, 'SUMMARY_DAILY_LIMIT');
  assert.equal((await runtime.memory.status()).usage.today.requests, 0);
  await runtime.memory.save({ text: '', autoUpdate: true, expectedRevision: 0, preferences: { memoryDailyTokens: 100000 } });
  await runManual(runtime); assert.equal(calls, 1);
});

test('A provider that ignores abort is bounded by timeout and cannot overwrite the summary later', async t => {
  const { runtime } = await setup(t, { memoryTimeoutMs: 100 });
  runtime.memory.setGenerator(generator(async () => new Promise(() => {})));
  await runtime.memory.kick();
  assert.equal(runtime.memory.lastError.code, 'ABORTED'); assert.equal((await runtime.memory.status()).pending, 2);
  assert.equal((await runtime.memory.status()).usage.today.unknownRequests, 1);
});

test('Locked entries and manual edits are protected from old history; source ids are validated', () => {
  const entries = [{ id: 'a', text: '手动事实', protectedAt: 100, locked: false, sources: [] }];
  const patch = { operations: [{ op: 'replace', id: 'a', text: '新事实', sources: ['s'] }] };
  assert.throws(() => applyMemoryPatch(entries, patch, [{ id: 's', time: 10 }]), { code: 'SUMMARY_PROTECTED' });
  assert.equal(applyMemoryPatch(entries, patch, [{ id: 's', time: 101 }])[0].text, '新事实');
  assert.throws(() => applyMemoryPatch([{ ...entries[0], locked: true }], patch, [{ id: 's', time: 101 }]), { code: 'SUMMARY_LOCKED' });
  assert.throws(() => applyMemoryPatch(entries, patch, []), { code: 'SUMMARY_INVALID_SOURCE' });
  assert.throws(() => parsePatch('{"operations":[{"op":"replace","id":"a","text":"x"}]}'), { code: 'SUMMARY_INVALID_PATCH' });
});

test('Only the opening user turn receives a summary, even after context compaction', async t => {
  const { runtime, config } = await setup(t);
  await runtime.memory.save({ text: '偏好中文；正在开发插件。', autoUpdate: false, expectedRevision: 0 });
  let requestHeader;
  const agent = { session: { id: 'new-chat', header: {}, surface: { nodes: [] }, eventAt() {}, append() {}, requestHeader: () => requestHeader } };
  const input = message('你好'); const decision = { kind: 'enter', messages: [input] };
  const run = (turn, step) => preStep(runtime)({ agent, messages: [input], turn, step }, async () => decision);
  const first = await run(1, 1); assert.equal(first.messages.length, 2);
  const injected = first.messages[1]; assert.equal(injected.source.kind, 'history-rag-memory');
  assert.equal(eventText({ type: 'user/message', data: injected }, config), null);
  assert.equal((await run(1, 2)).messages.length, 1); assert.equal((await run(2, 1)).messages.length, 1);
  requestHeader = {}; assert.equal((await run(1, 1)).messages.length, 1);
  requestHeader = undefined; runtime.recall = async () => { throw new Error('retrieval unavailable'); };
  assert.equal((await run(1, 1)).messages[1].source.kind, 'history-rag-memory');
});

test('Source exclusions, fork deduplication and source edits are respected by memory', async t => {
  const { runtime, sessions } = await setup(t, { excludeSessionIds: ['excluded'] });
  sessions.set('fork', snapshot('fork', ['偏好使用中文回复'])); sessions.set('excluded', snapshot('excluded', ['不应进入摘要']));
  await rescan(runtime); assert.equal((await runtime.memory.status()).total, 2);
  let finish;
  runtime.memory.setGenerator(generator(input => new Promise(resolve => { finish = () => resolve(add(input, '旧源不应保存')); })));
  const running = runtime.memory.kick(); await until(() => Boolean(finish));
  sessions.set('a', snapshot('a', ['编辑过的原文'])); sessions.delete('fork'); runtime.markDirty('a'); await until(() => !runtime.pumpRunning);
  finish(); await running;
  assert.equal((await runtime.memory.read()).text, '');
});

test('Selected model settings and history restoration survive restart without rolling back receipts', async t => {
  const { runtime, config, source } = await setup(t);
  runtime.memory.setGenerator({ ...generator(input => add(input, '自动摘要')), hasProvider: p => p === 'configured' });
  await assert.rejects(runtime.memory.save({ text: '', autoUpdate: false, expectedRevision: 0, modelSelection: { provider: 'missing', model: 'x' } }), { code: 'NO_SUMMARY_MODEL' });
  await runtime.memory.kick();
  await runtime.memory.save({ text: '手动修订', autoUpdate: false, expectedRevision: 1, modelSelection: { provider: 'configured', model: 'chat' }, preferences: { memoryDailyTokens: 123456 } });
  assert.equal((await runtime.db.call('memoryHistory')).length, 3);
  await runtime.memory.restore({ expectedRevision: 2, revision: 1 });
  assert.equal((await runtime.memory.read()).text, '自动摘要'); assert.equal((await runtime.memory.status()).pending, 0);
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start();
  const record = await reopened.memory.read();
  assert.equal(record.preferences.memoryDailyTokens, 123456); assert.deepEqual(record.modelSelection, { provider: 'configured', model: 'chat' });
});

test('A crashed in-flight request remains accounted and requires explicit retry after restart', async t => {
  const { runtime, config, source } = await setup(t);
  runtime.memory.setGenerator(generator(async input => { input.onUsage({ inputTokens: 0, outputTokens: 0 }); throw Object.assign(new Error('truncated'), { code: 'SUMMARY_TRUNCATED' }); }));
  await runtime.memory.kick();
  const id = await runtime.db.call('reserveMemoryRequest', { runId: 'crashed', phase: 'update', provider: 'synthetic', model: 'summary-model', reserved: 34000 }, 0);
  runtime.memory.work.activeRequestId = id; runtime.memory.work.failure = null; await runtime.memory.persistWork();
  await runtime.close();
  const reopened = track(t, new HistoryRag(config, source)); await reopened.start(); await rescan(reopened);
  assert.equal(reopened.memory.lastError.code, 'SUMMARY_INTERRUPTED');
  let calls = 0; reopened.memory.setGenerator(generator(async () => { calls++; return { operations: [] }; }));
  await reopened.memory.kick(); assert.equal(calls, 0);
  const usage = (await reopened.memory.status()).usage.today;
  assert.equal(usage.failures, 2); assert.equal(usage.unknownRequests, 1); assert.equal(usage.budgetTokens, 34000);
});

test('Stable settings do not fragment existing paragraphs or lose entry provenance', async t => {
  const { runtime } = await setup(t);
  runtime.memory.setGenerator(generator(input => add(input, '第一段\n\n第二段'))); await runtime.memory.kick();
  const previous = await runtime.memory.read(); assert.equal(previous.entries.length, 1);
  await runtime.memory.save({ text: previous.text, autoUpdate: false, expectedRevision: previous.revision, preferences: { memoryDailyTokens: 100000 } });
  assert.deepEqual((await runtime.memory.read()).entries, previous.entries);
});

test('A disjoint manual edit can reuse staged changes without rereading the original batch', async t => {
  const { runtime } = await setup(t, { memoryMaxChars: 256 });
  await runtime.memory.save({ text: '旧'.repeat(230), autoUpdate: true, expectedRevision: 0 });
  let updates = 0;
  runtime.memory.setGenerator(generator(input => {
    if (input.phase === 'compact') return { operations: [] };
    updates++; return add(input, '新增事实'.repeat(15));
  }));
  await runtime.memory.kick(); assert.equal(runtime.memory.lastError.code, 'SUMMARY_CAPACITY');
  const previous = await runtime.memory.read();
  await runtime.memory.save({ text: '用户主动精简旧摘要', autoUpdate: true, expectedRevision: previous.revision });
  await runManual(runtime);
  assert.equal(updates, 1); assert.equal((await runtime.memory.status()).pending, 0);
  assert.equal((await runtime.memory.read()).text, '用户主动精简旧摘要\n\n' + '新增事实'.repeat(15));
});

test('Known native context capacity is enforced before issuing a paid request', async t => {
  const { runtime } = await setup(t); let calls = 0;
  runtime.memory.setGenerator({ ...generator(() => { calls++; return { operations: [] }; }), contextWindow: async () => 16000 });
  await runtime.memory.kick();
  assert.equal(calls, 0); assert.equal(runtime.memory.lastError.code, 'SUMMARY_CONTEXT_BUDGET');
  assert.equal((await runtime.memory.status()).usage.today.requests, 0);
});
