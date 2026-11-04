import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { chunksFromSnapshot } from '../lib/text.js';
import { tempConfig, snapshot, track } from './helpers.js';

test('v1 migration preserves text and paid partial ranges without RAG overlap or a full reprocess', async t => {
  const config = await tempConfig(t, { chunkChars: 64, chunkOverlap: 12 });
  const path = join(config.dataDir, 'legacy.sqlite'), legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,created_at INTEGER,indexed_at INTEGER NOT NULL);
    CREATE TABLE chunks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,seq INTEGER NOT NULL,part INTEGER NOT NULL,role TEXT NOT NULL,time INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE memory_summary(id INTEGER PRIMARY KEY,text TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,source TEXT NOT NULL,auto_update INTEGER NOT NULL);
    CREATE TABLE memory_seen(hash TEXT PRIMARY KEY); PRAGMA user_version=1;
    INSERT INTO memory_summary VALUES(1,'旧摘要完整保留',7,100,'automatic',1);
    INSERT INTO sessions VALUES('a','project',1,1);`);
  const original = snapshot('a', ['已处理的第一条消息', Array.from({ length: 50 }, (_, i) => `第${i}段的原文。`).join('')]);
  const chunks = chunksFromSnapshot(original, config);
  const insert = legacy.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const c of chunks) insert.run(c.id, c.sessionId, c.seq, c.part, c.role, c.time, c.start, c.end, c.text, c.hash);
  for (const c of chunks.filter(c => c.seq === 0 || c.part < 2)) legacy.prepare('INSERT INTO memory_seen VALUES(?)').run(c.hash);
  legacy.close();
  const store = track(t, new Store(path));
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(store.readMemory().text, '旧摘要完整保留'); assert.equal(store.readMemory().revision, 7);
  assert.equal(store.memoryCounts().pending, 1);
  const batch = store.memoryBatch(config, 8000);
  const expectedStart = chunks.filter(c => c.seq === 1 && c.part < 2).at(-1).end;
  assert.equal(batch.additions[0].start, expectedStart);
  assert.equal(batch.additions[0].text, Array.from(original.events[1].data.message.content[0].text).slice(expectedStart).join(''));
  assert.ok(batch.context.length);
  const saved = store.commitMemoryDocument(7, store.readMemory().entries, batch.receipts, config);
  assert.equal(saved.revision, 7); assert.equal(store.memoryCounts().pending, 0);
  store.sync(original.session, chunksFromSnapshot(original, { ...config, chunkChars: 90, chunkOverlap: 8 }));
  assert.equal(store.memoryCounts().pending, 0, 'Changing embedding chunks must not re-read memory sources');
});

test('Equal-time fragments reconstruct message order, and user/assistant copies retain distinct provenance', async t => {
  const config = await tempConfig(t, { chunkChars: 64, chunkOverlap: 12 });
  const store = track(t, new Store(join(config.dataDir, 'test.sqlite')));
  const original = snapshot('a', ['甲'.repeat(100) + '乙'.repeat(100), '甲'.repeat(100) + '乙'.repeat(100)]);
  original.events.forEach(event => { event.time = 1; });
  store.sync(original.session, chunksFromSnapshot(original, config));
  const batch = store.memoryBatch(config, 8000);
  assert.deepEqual(batch.additions.map(s => s.seq), [0, 1]);
  assert.equal(batch.additions[0].text, original.events[0].data.content[0].text);
  assert.equal(store.memoryCounts().total, 2);
});

test('Receipt commits and version checks are atomic; deleted source cannot be marked processed', async t => {
  const config = await tempConfig(t), store = track(t, new Store(join(config.dataDir, 'test.sqlite')));
  const original = snapshot('a', ['原文']); store.sync(original.session, chunksFromSnapshot(original, config));
  const batch = store.memoryBatch(config, 8000);
  store.saveMemory(0, '手动', true);
  assert.equal(store.commitMemoryDocument(0, [], batch.receipts, config), null);
  assert.equal(store.memoryCounts().pending, 1);
  store.sync(original.session, []);
  assert.equal(store.commitMemoryDocument(1, [], batch.receipts, config), null);
  assert.equal(store.readMemory().text, '手动');
});

test('A duplicate usage finalization cannot bill twice and abandoned requests retain conservative budget', async t => {
  const config = await tempConfig(t), store = track(t, new Store(join(config.dataDir, 'test.sqlite')));
  const id = store.reserveMemoryRequest({ runId: 'run', phase: 'update', provider: 'test', model: 'test', reserved: 1000 }, 2000);
  assert.equal(store.memoryUsage('run').today.unknownRequests, 1);
  store.finishMemoryRequest(id, { inputTokens: 20, outputTokens: 30 }, null);
  store.finishMemoryRequest(id, { inputTokens: 900, outputTokens: 900 }, null);
  assert.equal(store.memoryUsage('run').today.budgetTokens, 50);
  store.reserveMemoryRequest({ runId: 'run', phase: 'update', provider: 'test', model: 'test', reserved: 1000 }, 2000);
  assert.equal(store.memoryUsage('run').today.budgetTokens, 1050);
});

test('Repeating a fact later is reconsidered, while inherited copies with the same source time are deduplicated', async t => {
  const config = await tempConfig(t), store = track(t, new Store(join(config.dataDir, 'test.sqlite')));
  const first = snapshot('a', ['我喜欢中文']); store.sync(first.session, chunksFromSnapshot(first, config));
  const batch = store.memoryBatch(config, 8000); store.commitMemoryDocument(0, [], batch.receipts, config);
  const fork = snapshot('fork', ['我喜欢中文']); store.sync(fork.session, chunksFromSnapshot(fork, config));
  assert.equal(store.memoryCounts().pending, 0);
  const later = snapshot('b', ['我喜欢中文']); later.events[0].time = 999;
  store.sync(later.session, chunksFromSnapshot(later, config));
  assert.equal(store.memoryCounts().pending, 1); assert.equal(store.memoryBatch(config, 8000).additions[0].time, 999);
});
