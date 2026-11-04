import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { EmbeddingClient } from './embedding.js';
import { chunksFromSnapshot, messagesFromSnapshot, hash } from './text.js';
import { MemorySummary } from './memory.js';
import { MemoryEditGate } from './memory-tool.js';
import { UpdateChecker } from './updates.js';

export class HistoryRag {
  constructor(config, source, { client, database, report = () => {} } = {}) {
    this.config = config; this.source = source; this.report = report;
    this.client = client || new EmbeddingClient(config);
    this.db = database || new Database(join(config.dataDir, 'history.sqlite'), { ownerToken: randomUUID() });
    this.stop = new AbortController(); this.dirty = new Set(); this.fingerprints = new Map();
    this.providerGeneration = new AbortController();
    this.scanPending = new Set(); this.progress = null;
    this.embeddingActive = false; this.embeddingRetryAt = 0;
    this.scanRunning = null; this.pumpRunning = null; this.embedRunning = null;
    this.sessionFailures = new Map();
    this.lastError = null; this.closed = false;
    this.memory = new MemorySummary(this);
    this.memoryEdits = new MemoryEditGate();
    this.updates = new UpdateChecker(this);
  }
  recordError(stage, error) {
    // Do not persist source text, endpoint response bodies, or credentials in diagnostics.
    const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'FAILED';
    this.lastError = { stage, code, time: Date.now() };
    const label = `${stage}:${code}`;
    if (this.lastReport !== label || Date.now() - (this.lastReportAt || 0) >= 60000) {
      this.report(this.lastError); this.lastReport = label; this.lastReportAt = Date.now();
    }
    if (!this.closed) this.db.call('setState', 'lastError', this.lastError).catch(() => {});
  }
  async start() {
    await this.db.ready;
    if (this.closed) return;
    const previous = await this.db.call('status', this.client.identity);
    this.sessionFailures = new Map((previous.state.sessionFailures || []).map(f => [f.sessionId, f]));
    await this.memory.start();
    this.updates.start(previous.state.updateCheck);
    this.scan().catch(error => this.recordError('scan', error));
    this.scanTimer = setInterval(() => this.scan().catch(error => this.recordError('scan', error)), this.config.scanIntervalMs);
    this.scanTimer.unref();
    this.embedRunning = this.embeddingLoop();
  }
  eligible(session) {
    return !this.config.excludeSessionIds.includes(session.id)
      && !this.config.excludeWorkspaces.includes(session.cwd || '');
  }
  markDirty(id) {
    if (this.closed || typeof id !== 'string') return;
    this.dirty.add(id);
    if (!this.pumpRunning) {
      this.pumpRunning = this.pump().finally(() => {
        this.pumpRunning = null;
        if (this.dirty.size && !this.closed) this.markDirty(this.dirty.values().next().value);
      });
    }
  }
  async scan() {
    if (this.scanRunning) return this.scanRunning;
    if (this.closed) return;
    this.scanRunning = (async () => {
      // A rebuild request is only consumed by the running owner of the index.
      const request = join(this.config.dataDir, 'rebuild.request');
      try {
        const token = (await readFile(request, 'utf8')).trim();
        if (token === 'vectors') await this.db.call('rebuild', this.client.identity);
        this.fingerprints.clear();
        await unlink(request);
      } catch (error) { if (error.code !== 'ENOENT') this.recordError('rebuild', error); }
      this.progress = { phase: 'listing', total: null, completed: 0, failed: 0, startedAt: Date.now() };
      const records = await this.source.listSessions(this.stop.signal);
      if (this.closed) return;
      // No day window, archive filter, relevance filter, or session-count ceiling.
      const eligible = records.filter(record => record.header && this.eligible(record.header));
      this.scanPending = new Set(eligible.map(record => record.header.id));
      this.progress = { phase: eligible.length ? 'indexing' : 'complete', total: eligible.length,
        completed: 0, failed: 0, startedAt: this.progress.startedAt };
      await this.db.call('setState', 'indexProgress', this.progress);
      for (const record of records) {
        const session = record.header;
        if (!session || typeof session.id !== 'string') throw new Error('不支持的 DSH 会话列表格式');
        if (this.eligible(session)) this.markDirty(session.id);
      }
      await this.db.call('setState', 'lastScan', { time: Date.now(), discoveredSessions: records.length });
    })().catch(async error => {
      if (!this.closed) {
        this.progress = { ...this.progress, phase: 'failed' };
        await this.db.call('setState', 'indexProgress', this.progress).catch(() => {});
      }
      throw error;
    }).finally(() => { this.scanRunning = null; });
    return this.scanRunning;
  }
  async pump() {
    while (this.dirty.size && !this.closed) {
      const id = this.dirty.values().next().value;
      this.dirty.delete(id);
      let failed = false;
      try {
        const snapshot = await this.source.readSession(id);
        if (this.closed) return;
        if (snapshot.session.id !== id) throw new Error('DSH 返回了错误的会话');
        if (!this.eligible(snapshot.session)) continue;
        const chunks = chunksFromSnapshot(snapshot, this.config);
        const fingerprint = hash(JSON.stringify([snapshot.session.cwd, chunks.map(c => [c.id, c.hash, c.role, c.time, c.start, c.end])]));
        if (this.fingerprints.get(id) !== fingerprint) {
          await this.db.call('sync', snapshot.session, chunks, messagesFromSnapshot(snapshot, this.config));
          this.memory.markDirty();
          this.fingerprints.set(id, fingerprint);
        }
        if (this.sessionFailures.delete(id)) await this.db.call('setState', 'sessionFailures', [...this.sessionFailures.values()]);
      } catch (error) {
        failed = true;
        if (!this.closed) {
          this.recordError('session', error);
          this.sessionFailures.set(id, { sessionId: id, code: this.lastError.code, time: Date.now() });
          await this.db.call('setState', 'sessionFailures', [...this.sessionFailures.values()]).catch(() => {});
        }
      } finally {
        if (!this.closed && this.scanPending.delete(id)) {
          this.progress.completed++;
          if (failed) this.progress.failed++;
          if (!this.scanPending.size) this.progress.phase = 'complete';
          await this.db.call('setState', 'indexProgress', this.progress).catch(() => {});
        }
      }
      await yieldTurn();
    }
  }
  async embeddingLoop() {
    let failures = 0;
    while (!this.closed) {
      const client = this.client, config = this.config, generation = this.providerGeneration;
      const signal = AbortSignal.any([this.stop.signal, generation.signal]);
      try {
        if (!client.configured) { await delay(1000, undefined, { signal }); continue; }
        const pending = await this.db.call('pending', client.identity, config.batchSize);
        if (generation.signal.aborted) continue;
        if (!pending.length) { await delay(500, undefined, { signal }); continue; }
        try {
          this.embeddingActive = true;
          const vectors = await client.embed(pending.map(c => c.text), { signal });
          if (this.closed) return;
          if (generation.signal.aborted) continue;
          await this.db.call('putEmbeddings', client.identity, pending.map(c => c.hash), vectors);
          failures = 0; this.embeddingRetryAt = 0;
        } catch (error) {
          if (this.closed) return;
          if (generation.signal.aborted) continue;
          await this.db.call('failed', client.identity, pending.map(c => c.hash));
          this.recordError('embedding', error);
          failures++;
          const wait = Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
          this.embeddingRetryAt = Date.now() + wait;
          this.embeddingActive = false;
          await delay(wait, undefined, { signal });
        } finally {
          this.embeddingActive = false;
        }
      } catch (error) {
        if (this.closed) return;
        if (generation.signal.aborted) { failures = 0; continue; }
        this.recordError('embedding', error);
        try { await delay(1000, undefined, { signal: this.stop.signal }); } catch { return; }
      }
    }
  }
  async recall(query, options = {}, signal) {
    if (!this.client.configured || this.closed || !query.trim()) return [];
    const client = this.client, config = this.config, generation = this.providerGeneration;
    const budget = AbortSignal.timeout(config.recallTimeoutMs);
    const combined = AbortSignal.any([this.stop.signal, generation.signal, budget, ...(signal ? [signal] : [])]);
    const work = (async () => {
      const [vector] = await client.embed([Array.from(query).slice(0, config.queryMaxChars).join('')], { query: true, signal: combined });
      if (combined.aborted) throw new Error('检索已取消');
      return this.db.search(client.identity, vector, {
        topK: config.topK, minScore: config.minScore, scope: config.scope,
        excludeSessionIds: config.excludeSessionIds, excludeWorkspaces: config.excludeWorkspaces,
        ...options,
      }, combined);
    })();
    // Host cancellation also bounds a custom/injected provider that ignores AbortSignal.
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new Error('检索已取消或超时'));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    try { return await Promise.race([work, cancelled]); }
    catch (error) { if (generation.signal.aborted) return []; throw error; }
    finally { combined.removeEventListener('abort', abort); }
  }
  async keywordRecall(query, options = {}, signal) {
    if (this.closed || !query.trim()) return [];
    const config = this.config;
    const combined = AbortSignal.any([this.stop.signal, AbortSignal.timeout(config.recallTimeoutMs), ...(signal ? [signal] : [])]);
    const work = this.db.keywordSearch(Array.from(query).slice(0, config.queryMaxChars).join(''), {
      topK: config.topK, scope: config.scope, excludeSessionIds: config.excludeSessionIds,
      excludeWorkspaces: config.excludeWorkspaces, ...options,
    }, combined);
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(new Error('关键词检索已取消或超时'));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    try { return await Promise.race([work, cancelled]); }
    finally { combined.removeEventListener('abort', abort); }
  }
  async status() {
    return { configured: this.client.configured, model: this.config.embeddingModel || null,
      indexing: Boolean(this.pumpRunning || this.scanRunning), queuedSessions: this.dirty.size,
      progress: this.progress, embeddingActive: this.embeddingActive, embeddingRetryAt: this.embeddingRetryAt,
      memory: await this.memory.status(),
      updates: this.updates.status(),
      ...await this.db.call('status', this.client.identity) };
  }
  reconfigure(config) {
    if (this.closed) throw new Error('插件已关闭');
    const client = new EmbeddingClient(config);
    this.providerGeneration.abort();
    this.providerGeneration = new AbortController();
    this.config = config; this.client = client;
    this.embeddingRetryAt = 0;
    this.memory.invalidate();
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.scanTimer); this.stop.abort();
    await this.updates.close();
    await this.memory.close();
    // Public source reads do not all accept cancellation; let their continuations
    // notice closed instead of holding plugin disposal indefinitely.
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([this.embedRunning, this.scanRunning, this.pumpRunning]),
        new Promise(resolve => { timer = setTimeout(resolve, 1000); }),
      ]);
    } finally { clearTimeout(timer); }
    await this.db.close();
  }
}
