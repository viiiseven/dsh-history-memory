import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function pack(vector) {
  const b = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) b.writeFloatLE(vector[i], i * 4);
  return b;
}

export class Store {
  constructor(path, ownerToken) {
    this.ownerToken = ownerToken;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('数据库版本比插件新，已拒绝修改'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at INTEGER, indexed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, part INTEGER NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL,
        start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
      CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(hash);
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, dimensions INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings(
        model TEXT NOT NULL REFERENCES models(id), hash TEXT NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY(model, hash)
      );
      CREATE TABLE IF NOT EXISTS retries(model TEXT NOT NULL, hash TEXT NOT NULL, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(model, hash));
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_summary(id INTEGER PRIMARY KEY CHECK(id=1), text TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, auto_update INTEGER NOT NULL);
      INSERT OR IGNORE INTO memory_summary VALUES(1,'',0,0,'empty',1);
      CREATE TABLE IF NOT EXISTS memory_seen(hash TEXT PRIMARY KEY);
      PRAGMA user_version=1;
    `);
    if (ownerToken) this.acquire();
  }
  acquire() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare('SELECT * FROM owner WHERE id=1').get();
      if (owner && owner.expires_at > Date.now() && owner.token !== this.ownerToken) throw new Error('该索引已由另一 DSH 实例使用，请为第二个实例设置不同 dataDir');
      this.db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?)').run(this.ownerToken, Date.now() + 60000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertOwner() {
    if (!this.ownerToken) return;
    if (this.db.prepare('SELECT token FROM owner WHERE id=1').get()?.token !== this.ownerToken) throw new Error('索引写入租约已失效');
  }
  renew() {
    this.assertOwner();
    this.db.prepare('UPDATE owner SET expires_at=? WHERE token=?').run(Date.now() + 60000, this.ownerToken);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.assertOwner(); const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sync(session, chunks) {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,indexed_at=excluded.indexed_at`)
        .run(session.id, session.cwd || '', session.createdAt || 0, Date.now());
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY); DELETE FROM incoming;');
      const incoming = this.db.prepare('INSERT INTO incoming VALUES(?)');
      const put = this.db.prepare(`INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        role=excluded.role,time=excluded.time,start=excluded.start,end=excluded.end,text=excluded.text,hash=excluded.hash WHERE chunks.hash != excluded.hash OR chunks.role != excluded.role OR chunks.start != excluded.start OR chunks.end != excluded.end`);
      for (const c of chunks) {
        incoming.run(c.id);
        put.run(c.id, session.id, c.seq, c.part, c.role, c.time || 0, c.start, c.end, c.text, c.hash);
      }
      this.db.prepare('DELETE FROM chunks WHERE session_id=? AND id NOT IN (SELECT id FROM incoming)').run(session.id);
      return chunks.length;
    });
  }
  pending(model, limit) {
    return this.db.prepare(`SELECT c.hash,MIN(c.text) text FROM chunks c
      LEFT JOIN embeddings e ON e.hash=c.hash AND e.model=?
      LEFT JOIN retries r ON r.hash=c.hash AND r.model=?
      WHERE e.hash IS NULL AND (r.retry_at IS NULL OR r.retry_at<=?)
      GROUP BY c.hash ORDER BY MIN(c.time), c.hash LIMIT ?`).all(model, model, Date.now(), limit);
  }
  putEmbeddings(model, hashes, vectors) {
    if (!hashes.length || hashes.length !== vectors.length) throw new Error('向量条数错误');
    const dim = vectors[0].length;
    if (!dim || vectors.some(v => v.length !== dim || [...v].some(x => !Number.isFinite(x)))) throw new Error('无效向量');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT dimensions FROM models WHERE id=?').get(model);
      if (previous && previous.dimensions !== dim) throw Object.assign(new Error('同一模型返回的维度改变，请更新模型名或 dimensions 后重新启动'), { code: 'DIMENSION_MISMATCH' });
      this.db.prepare('INSERT OR IGNORE INTO models VALUES(?,?)').run(model, dim);
      const put = this.db.prepare('INSERT OR REPLACE INTO embeddings VALUES(?,?,?)');
      const clear = this.db.prepare('DELETE FROM retries WHERE model=? AND hash=?');
      hashes.forEach((hash, i) => { put.run(model, hash, pack(vectors[i])); clear.run(model, hash); });
    });
  }
  failed(model, hashes) {
    const put = this.db.prepare(`INSERT INTO retries VALUES(?,?,1,?) ON CONFLICT(model,hash) DO UPDATE SET
      attempts=attempts+1,retry_at=? + MIN(900000,1000 * (1 << MIN(attempts,9)))`);
    const now = Date.now();
    return this.transaction(() => hashes.forEach(hash => put.run(model, hash, now + 2000, now)));
  }
  search(model, vector, options) {
    const meta = this.db.prepare('SELECT dimensions FROM models WHERE id=?').get(model);
    if (!meta) return [];
    if (meta.dimensions !== vector.length) throw new Error('查询向量与索引维度不一致');
    const query = this.db.prepare(`SELECT c.*,s.cwd,e.vector FROM chunks c
      JOIN sessions s ON s.id=c.session_id JOIN embeddings e ON e.hash=c.hash AND e.model=?
      ${options.scope === 'workspace' ? 'WHERE s.cwd=?' : ''}`);
    const args = options.scope === 'workspace' ? [model, options.cwd || ''] : [model];
    const excludedSessions = new Set(options.excludeSessionIds || []);
    const excludedCwds = new Set(options.excludeWorkspaces || []);
    const currentVisible = new Set(options.currentVisibleSeqs || []);
    const excludedHashes = new Set(options.excludeHashes || []);
    const best = [];
    const cancel = options.cancelBuffer ? new Int32Array(options.cancelBuffer) : null;
    // Exact cosine search lives in the database worker, never the DSH UI thread.
    for (const row of query.iterate(...args)) {
      if (cancel && Atomics.load(cancel, 0)) return [];
      if (excludedHashes.has(row.hash) || excludedSessions.has(row.session_id) || excludedCwds.has(row.cwd)
        || (row.session_id === options.currentSessionId && currentVisible.has(row.seq))) continue;
      const b = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      if (b.length !== vector.length * 4) throw new Error('索引向量损坏，请重建向量');
      let score = 0;
      for (let i = 0; i < vector.length; i++) score += vector[i] * b.readFloatLE(i * 4);
      if (score < options.minScore) continue;
      const hit = { id: row.id, sessionId: row.session_id, seq: row.seq, part: row.part,
        role: row.role, time: row.time, cwd: row.cwd, text: row.text, hash: row.hash, score,
        start: row.start, end: row.end };
      // Identical text inherited by forks occupies one result slot.
      const duplicate = best.findIndex(h => h.hash === hit.hash);
      if (duplicate >= 0 && best[duplicate].score >= score) continue;
      if (duplicate >= 0) best.splice(duplicate, 1);
      best.push(hit);
      best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      if (best.length > options.topK) best.pop();
    }
    return best;
  }
  keywordSearch(text, options) {
    const terms = [...new Set(text.toLowerCase().trim().split(/\s+/u).filter(Boolean))];
    if (!terms.length) return [];
    const excludedSessions = new Set(options.excludeSessionIds || []);
    const excludedCwds = new Set(options.excludeWorkspaces || []);
    const excludedHashes = new Set(options.excludeHashes || []);
    const currentVisible = new Set(options.currentVisibleSeqs || []);
    const cancel = options.cancelBuffer ? new Int32Array(options.cancelBuffer) : null;
    const query = this.db.prepare(`SELECT c.*,s.cwd FROM chunks c JOIN sessions s ON s.id=c.session_id
      ${options.scope === 'workspace' ? 'WHERE s.cwd=?' : ''}`);
    const best = [];
    for (const row of query.iterate(...(options.scope === 'workspace' ? [options.cwd || ''] : []))) {
      if (cancel && Atomics.load(cancel, 0)) return [];
      if (excludedHashes.has(row.hash) || excludedSessions.has(row.session_id) || excludedCwds.has(row.cwd)
        || (row.session_id === options.currentSessionId && currentVisible.has(row.seq))) continue;
      const lower = row.text.toLowerCase();
      if (!terms.every(term => lower.includes(term))) continue;
      const counts = terms.map(term => lower.split(term).length - 1);
      const phrase = lower.includes(text.toLowerCase().trim()) ? 1 : 0;
      const score = phrase + counts.reduce((sum, count) => sum + Math.log1p(count), 0) / Math.sqrt(Array.from(row.text).length || 1);
      const hit = { id: row.id, sessionId: row.session_id, seq: row.seq, part: row.part,
        role: row.role, time: row.time, cwd: row.cwd, text: row.text, hash: row.hash, score, start: row.start, end: row.end };
      const duplicate = best.findIndex(h => h.hash === hit.hash);
      if (duplicate >= 0 && best[duplicate].score >= score) continue;
      if (duplicate >= 0) best.splice(duplicate, 1);
      best.push(hit); best.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      if (best.length > options.topK) best.pop();
    }
    return best;
  }
  status(model) {
    const sessions = this.db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
    const chunks = this.db.prepare('SELECT COUNT(*) n FROM chunks').get().n;
    const embeddedChunks = this.db.prepare(`SELECT COUNT(*) n FROM chunks c JOIN embeddings e ON e.hash=c.hash AND e.model=?`).get(model).n;
    const pending = chunks - embeddedChunks;
    return { sessions, chunks, embeddedChunks, pending, coverage: chunks ? embeddedChunks / chunks : 0,
      dimensions: this.db.prepare('SELECT dimensions FROM models WHERE id=?').get(model)?.dimensions || null,
      state: Object.fromEntries(this.db.prepare('SELECT * FROM state').all().map(r => [r.key, JSON.parse(r.value)])) };
  }
  setState(key, value) { this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key, JSON.stringify(value)); }
  readMemory() {
    const row = this.db.prepare('SELECT * FROM memory_summary WHERE id=1').get();
    return { text: row.text, revision: row.revision, updatedAt: row.updated_at, source: row.source, autoUpdate: Boolean(row.auto_update) };
  }
  memoryFilter(options = {}) {
    const clauses = [], args = [];
    for (const [values, column] of [[options.excludeSessionIds, 'c.session_id'], [options.excludeWorkspaces, 's.cwd']]) {
      if (values?.length) { clauses.push(`${column} NOT IN (${values.map(() => '?').join(',')})`); args.push(...values); }
    }
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
  }
  pendingMemory(options = {}, limit = 64) {
    const filter = this.memoryFilter(options);
    return this.db.prepare(`SELECT c.*,s.cwd FROM chunks c JOIN sessions s ON s.id=c.session_id
      LEFT JOIN memory_seen m ON m.hash=c.hash WHERE m.hash IS NULL${filter.sql}
      GROUP BY c.hash ORDER BY MIN(c.time),c.hash LIMIT ?`).all(...filter.args, limit);
  }
  memoryCounts(options = {}) {
    const filter = this.memoryFilter(options);
    const row = this.db.prepare(`SELECT COUNT(DISTINCT c.hash) total,
      COUNT(DISTINCT CASE WHEN m.hash IS NULL THEN c.hash END) pending FROM chunks c
      JOIN sessions s ON s.id=c.session_id LEFT JOIN memory_seen m ON m.hash=c.hash WHERE 1=1${filter.sql}`).get(...filter.args);
    return { total: row.total, pending: row.pending, processed: row.total - row.pending };
  }
  saveMemory(expectedRevision, text, autoUpdate) {
    return this.transaction(() => {
      if (this.readMemory().revision !== expectedRevision) throw Object.assign(new Error('记忆摘要已更新，请重新加载后再保存'), { code: 'MEMORY_CONFLICT' });
      this.db.prepare("UPDATE memory_summary SET text=?,revision=revision+1,updated_at=?,source='manual',auto_update=? WHERE id=1").run(text, Date.now(), Number(autoUpdate));
      return this.readMemory();
    });
  }
  commitMemory(expectedRevision, text, hashes) {
    return this.transaction(() => {
      if (this.readMemory().revision !== expectedRevision) return null;
      // Content may be edited/deleted while the model is reading it. Never commit a stale batch.
      const exists = this.db.prepare('SELECT 1 FROM chunks WHERE hash=? LIMIT 1');
      if (!hashes.every(hash => exists.get(hash))) return null;
      this.db.prepare("UPDATE memory_summary SET text=?,revision=revision+1,updated_at=?,source='automatic' WHERE id=1").run(text, Date.now());
      const seen = this.db.prepare('INSERT OR IGNORE INTO memory_seen VALUES(?)');
      hashes.forEach(hash => seen.run(hash));
      return this.readMemory();
    });
  }
  rebuild(model) { return this.transaction(() => { this.db.prepare('DELETE FROM embeddings WHERE model=?').run(model); this.db.prepare('DELETE FROM retries WHERE model=?').run(model); this.db.prepare('DELETE FROM models WHERE id=?').run(model); }); }
  close() {
    if (this.ownerToken) this.db.prepare('DELETE FROM owner WHERE token=?').run(this.ownerToken);
    this.db.close();
  }
}
