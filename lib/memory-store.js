import { randomUUID } from 'node:crypto';
import { applyMemoryPatch, documentFromText, estimateTokens, fail, mergeRanges, messagesFromChunks, renderMemory, sourceHash, uncoveredRanges } from './memory-document.js';

export function localDay(time = Date.now()) {
  const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class MemoryStore {
  initializeMemory() {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_sources(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL, role TEXT NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, queued_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS memory_sources_hash ON memory_sources(hash);
        CREATE INDEX IF NOT EXISTS memory_sources_order ON memory_sources(session_id,seq);
        CREATE TABLE IF NOT EXISTS memory_receipts(hash TEXT PRIMARY KEY, ranges TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_versions(revision INTEGER PRIMARY KEY, time INTEGER NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, entries TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_requests(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, day TEXT NOT NULL, started INTEGER NOT NULL,
          finished INTEGER, phase TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, reserved INTEGER NOT NULL, usage TEXT, error TEXT);
        CREATE INDEX IF NOT EXISTS memory_requests_day ON memory_requests(day);
        CREATE TABLE IF NOT EXISTS memory_explicit(request_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      `);
      if (!this.getState('memoryDocument')) {
        const row = this.db.prepare('SELECT * FROM memory_summary WHERE id=1').get();
        this.setState('memoryDocument', documentFromText(row.text, [], row.updated_at, row.source));
        // Migrate paid v1 receipts as source ranges, including partially processed messages.
        for (const session of this.db.prepare('SELECT * FROM sessions').all()) {
          const chunks = this.db.prepare('SELECT * FROM chunks WHERE session_id=? ORDER BY seq,start').all(session.id);
          this.syncMemorySources(session, messagesFromChunks(chunks));
          for (const message of this.db.prepare('SELECT * FROM memory_sources WHERE session_id=?').all(session.id)) {
            const covered = chunks.filter(c => c.seq === message.seq && this.db.prepare('SELECT 1 FROM memory_seen WHERE hash=?').get(c.hash)).map(c => [c.start, c.end]);
            this.addMemoryReceipt(message.hash, covered);
          }
        }
        this.snapshotMemory();
      }
      this.db.exec('PRAGMA user_version=2;');
    });
  }
  getState(key) { const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  syncMemorySources(session, messages) {
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS incoming_memory(id TEXT PRIMARY KEY); DELETE FROM incoming_memory;');
    const incoming = this.db.prepare('INSERT INTO incoming_memory VALUES(?)');
    const put = this.db.prepare(`INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      role=excluded.role,time=excluded.time,text=excluded.text,hash=excluded.hash,queued_at=excluded.queued_at WHERE memory_sources.hash!=excluded.hash OR memory_sources.time!=excluded.time`);
    for (const message of messages) {
      const id = `${session.id}:${message.seq}`; incoming.run(id);
      put.run(id, session.id, message.seq, message.role, message.time || 0, message.text, sourceHash(message.role, message.text, message.time || 0), Date.now());
    }
    this.db.prepare('DELETE FROM memory_sources WHERE session_id=? AND id NOT IN (SELECT id FROM incoming_memory)').run(session.id);
  }
  readMemory() {
    const row = this.db.prepare('SELECT * FROM memory_summary WHERE id=1').get();
    const target = this.db.prepare('SELECT provider,model FROM memory_model WHERE id=1').get();
    return { text: row.text, revision: row.revision, updatedAt: row.updated_at, source: row.source, autoUpdate: Boolean(row.auto_update),
      modelSelection: target ? { provider: target.provider, model: target.model } : null,
      entries: this.getState('memoryDocument') || [], preferences: this.getState('memoryPreferences') || {} };
  }
  memoryFilter(options = {}, alias = 'd') {
    const clauses = [], args = [];
    for (const [values, column] of [[options.excludeSessionIds, `${alias}.session_id`], [options.excludeWorkspaces, 's.cwd']]) {
      if (values?.length) { clauses.push(`${column} NOT IN (${values.map(() => '?').join(',')})`); args.push(...values); }
    }
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
  }
  memoryRows(options = {}) {
    const filter = this.memoryFilter(options);
    return this.db.prepare(`SELECT * FROM (SELECT d.*,s.cwd,r.ranges,
      ROW_NUMBER() OVER (PARTITION BY d.hash ORDER BY d.time,d.session_id,d.seq) n
      FROM memory_sources d JOIN sessions s ON s.id=d.session_id LEFT JOIN memory_receipts r ON r.hash=d.hash
      WHERE 1=1${filter.sql}) WHERE n=1 ORDER BY time,session_id,seq`).all(...filter.args);
  }
  memoryCounts(options = {}) {
    let total = 0, pending = 0, pendingTokens = 0, oldestPendingAt = 0;
    for (const row of this.memoryRows(options)) {
      total++;
      const chars = Array.from(row.text), ranges = uncoveredRanges(chars.length, JSON.parse(row.ranges || '[]'));
      if (!ranges.length) continue;
      pending++; oldestPendingAt = oldestPendingAt ? Math.min(oldestPendingAt, row.queued_at) : row.queued_at;
      for (const [start, end] of ranges) pendingTokens += estimateTokens(chars.slice(start, end).join(''));
    }
    return { total, pending, processed: total - pending, pendingTokens, oldestPendingAt, unit: 'messages' };
  }
  memoryBatch(options, tokenBudget) {
    const additions = [], receipts = []; let used = 0, size = 0;
    const maxChars = options.memoryInputChars;
    outer: for (const row of this.memoryRows(options)) {
      const chars = Array.from(row.text);
      for (const [start, end] of uncoveredRanges(chars.length, JSON.parse(row.ranges || '[]'))) {
        // Include metadata in the estimate; no fixed fragment-count cap.
        const overhead = estimateTokens(JSON.stringify({ sessionId: row.session_id, seq: row.seq, role: row.role, cwd: row.cwd, time: row.time })) + 80;
        let take = Math.min(end - start, maxChars - size);
        if (take <= 0 || used + overhead + 4 > tokenBudget) break outer;
        let low = 0, high = take;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (estimateTokens(chars.slice(start, start + middle).join('')) + used + overhead <= tokenBudget) low = middle; else high = middle - 1;
        }
        take = low;
        // Prefer a paragraph/message boundary when splitting a large source.
        if (start + take < end) {
          const sample = chars.slice(start, start + take);
          const newline = sample.lastIndexOf('\n');
          if (newline > take * 0.6) take = newline + 1;
        }
        if (!take) break outer;
        const finish = start + take, text = chars.slice(start, finish).join('');
        const id = `${row.id}:${start}-${finish}`;
        additions.push({ id, sessionId: row.session_id, seq: row.seq, role: row.role, time: row.time, cwd: row.cwd, text, start, end: finish });
        receipts.push({ id: row.id, hash: row.hash, start, end: finish });
        used += overhead + estimateTokens(text); size += take;
        if (finish < end) break outer;
      }
    }
    // A small, explicitly read-only bridge for pronouns and split messages.
    const context = [];
    const first = additions[0];
    if (first) {
      const row = this.db.prepare('SELECT * FROM memory_sources WHERE session_id=? AND seq<=? ORDER BY seq DESC LIMIT 2').all(first.sessionId, first.seq);
      let remaining = 1200;
      for (const item of row) {
        const end = item.seq === first.seq ? first.start : Array.from(item.text).length;
        if (!end || remaining <= 0) continue;
        const text = Array.from(item.text).slice(Math.max(0, end - remaining), end).join('');
        remaining -= Array.from(text).length;
        context.unshift({ sessionId: item.session_id, seq: item.seq, role: item.role, text, contextOnly: true });
      }
    }
    return { additions, receipts, context, estimatedTokens: used + estimateTokens(JSON.stringify(context)) };
  }
  addMemoryReceipt(hash, ranges) {
    if (!ranges.length) return;
    const old = this.db.prepare('SELECT ranges FROM memory_receipts WHERE hash=?').get(hash);
    const merged = mergeRanges([...(old ? JSON.parse(old.ranges) : []), ...ranges]);
    this.db.prepare('INSERT OR REPLACE INTO memory_receipts VALUES(?,?)').run(hash, JSON.stringify(merged));
  }
  validMemoryReceipts(receipts, options = {}) {
    const filter = this.memoryFilter(options);
    const get = this.db.prepare(`SELECT d.* FROM memory_sources d JOIN sessions s ON s.id=d.session_id WHERE d.id=? AND d.hash=?${filter.sql}`);
    return receipts.every(r => {
      const row = get.get(r.id, r.hash, ...filter.args);
      return row && Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= Array.from(row.text).length;
    });
  }
  snapshotMemory() {
    const row = this.readMemory();
    this.db.prepare('INSERT OR REPLACE INTO memory_versions VALUES(?,?,?,?,?)').run(row.revision, row.updatedAt, row.source, row.text, JSON.stringify(row.entries));
  }
  writeMemory(entries, source) {
    const text = renderMemory(entries);
    this.db.prepare('UPDATE memory_summary SET text=?,revision=revision+1,updated_at=?,source=? WHERE id=1').run(text, Date.now(), source);
    this.setState('memoryDocument', entries); this.snapshotMemory(); return this.readMemory();
  }
  saveMemory(expectedRevision, text, autoUpdate, modelSelection, preferences, lockedIds) {
    return this.transaction(() => {
      const previous = this.readMemory();
      if (previous.revision !== expectedRevision) throw fail('MEMORY_CONFLICT', '摘要已更新，请重新加载后再保存');
      const entries = documentFromText(text, previous.entries);
      if (lockedIds !== undefined) {
        if (lockedIds.some(id => !previous.entries.some(entry => entry.id === id))) throw fail('BAD_INPUT', '锁定条目不存在');
        for (const entry of entries) entry.locked = lockedIds.includes(entry.id);
      }
      this.db.prepare('UPDATE memory_summary SET auto_update=? WHERE id=1').run(Number(autoUpdate));
      if (modelSelection === null) this.db.prepare('DELETE FROM memory_model WHERE id=1').run();
      else if (modelSelection !== undefined) this.db.prepare('INSERT OR REPLACE INTO memory_model VALUES(1,?,?)').run(modelSelection.provider, modelSelection.model);
      if (preferences) this.setState('memoryPreferences', { ...previous.preferences, ...preferences });
      return this.writeMemory(entries, 'manual');
    });
  }
  commitMemoryDocument(expectedRevision, entries, receipts, options) {
    return this.transaction(() => {
      if (this.readMemory().revision !== expectedRevision || !this.validMemoryReceipts(receipts, options)) return null;
      for (const receipt of receipts) this.addMemoryReceipt(receipt.hash, [[receipt.start, receipt.end]]);
      const previous = this.readMemory();
      const saved = JSON.stringify(previous.entries) === JSON.stringify(entries) ? previous : this.writeMemory(entries, 'automatic');
      this.setState('memoryWork', null);
      return saved;
    });
  }
  memoryHistory() {
    return this.db.prepare('SELECT revision,time,source,text,entries FROM memory_versions ORDER BY revision DESC LIMIT 30').all()
      .map(row => ({ ...row, entries: JSON.parse(row.entries) }));
  }
  restoreMemory(expectedRevision, revision, maxChars) {
    return this.transaction(() => {
      if (this.readMemory().revision !== expectedRevision) throw fail('MEMORY_CONFLICT');
      const row = this.db.prepare('SELECT * FROM memory_versions WHERE revision=?').get(revision);
      if (!row || row.text.length > maxChars) throw fail('BAD_INPUT', '版本不存在或超过当前摘要容量');
      const entries = JSON.parse(row.entries).map(entry => ({ ...entry, protectedAt: Date.now() }));
      return this.writeMemory(entries, 'manual');
    });
  }
  editMemoryExplicit(expectedRevision, patch, evidence, requestId, maxChars) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM memory_explicit WHERE request_id=?').get(requestId)) throw fail('MEMORY_REQUEST_USED', '这条记忆编辑请求已经执行');
      const previous = this.readMemory();
      if (previous.revision !== expectedRevision) throw fail('MEMORY_CONFLICT');
      const entries = applyMemoryPatch(previous.entries, patch, [evidence], { explicit: true });
      if (renderMemory(entries).length > maxChars) throw fail('SUMMARY_CAPACITY', '记忆已满，请在设置中精简或调整容量');
      const saved = this.writeMemory(entries, 'explicit');
      this.db.prepare('INSERT INTO memory_explicit VALUES(?,?)').run(requestId, saved.revision);
      return saved;
    });
  }
  reserveMemoryRequest(request, dailyLimit) {
    return this.transaction(() => {
      const day = localDay();
      const used = this.memoryUsage(null, day).today.budgetTokens;
      if (dailyLimit && used + request.reserved > dailyLimit) throw fail('SUMMARY_DAILY_LIMIT', '今日摘要预算不足以开始下一次请求');
      const id = randomUUID();
      this.db.prepare('INSERT INTO memory_requests VALUES(?,?,?,?,NULL,?,?,?,?,NULL,NULL)')
        .run(id, request.runId, day, Date.now(), request.phase, request.provider, request.model, request.reserved);
      return id;
    });
  }
  finishMemoryRequest(id, usage, error, work) {
    return this.transaction(() => {
      this.db.prepare('UPDATE memory_requests SET finished=?,usage=?,error=? WHERE id=? AND finished IS NULL')
        .run(Date.now(), usage ? JSON.stringify(usage) : null, error || null, id);
      if (work !== undefined) this.setState('memoryWork', work);
    });
  }
  memoryUsage(runId, day = localDay()) {
    const summarize = rows => rows.reduce((out, row) => {
      const usage = row.usage ? JSON.parse(row.usage) : null;
      out.requests++; if (row.error) out.failures++;
      out.elapsedMs += (row.finished ?? Date.now()) - row.started;
      if (usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) {
        out.inputTokens += usage.inputTokens; out.outputTokens += usage.outputTokens;
        out.budgetTokens += Math.max(usage.totalTokens || 0, usage.inputTokens + usage.outputTokens);
        for (const key of ['reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) if (Number.isFinite(usage[key])) { out[key] += usage[key]; out.details[key] = true; }
      } else { out.unknownRequests++; out.budgetTokens += row.reserved; }
      return out;
    }, { requests: 0, failures: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, details: {}, unknownRequests: 0, budgetTokens: 0 });
    return { day, today: summarize(this.db.prepare('SELECT * FROM memory_requests WHERE day=?').all(day)),
      run: summarize(runId ? this.db.prepare('SELECT * FROM memory_requests WHERE run_id=?').all(runId) : []) };
  }
}
