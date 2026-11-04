import { randomUUID } from 'node:crypto';
import { hash } from './text.js';
import { validateConfig } from './config.js';
import { MEMORY_INSTRUCTION, MEMORY_COMPACT_INSTRUCTION, MEMORY_INTRO } from './memory-prompts.js';
import { fail, applyMemoryPatch, estimateTokens, parsePatch, renderMemory } from './memory-document.js';
import { localDay } from './memory-store.js';
import { summaryInput } from './host-summary.js';

export { MemoryError } from './memory-document.js';
const PREFERENCES = ['memoryMaxChars', 'memoryMaxTokens', 'memoryBatchTokens', 'memoryTriggerTokens', 'memoryMaxWaitMs',
  'memoryContextTokens', 'memoryDailyTokens', 'memoryRetryLimit'];
const transient = error => [408, 429, 500, 502, 503, 504].includes(error.status)
  || ['ABORTED', 'TIMEOUT', 'NETWORK_ERROR', 'TRANSPORT', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'RATE_LIMITED'].includes(error.code);
function diagnostic(error) {
  const status = error.status ?? error.failure?.status;
  return { code: typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SUMMARY_FAILED', time: Date.now(),
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}) };
}

export class MemorySummary {
  constructor(runtime) {
    this.runtime = runtime; this.record = null; this.generator = null; this.lastTarget = null;
    this.lastDirtyAt = Date.now(); this.lastRunAt = 0; this.retryAt = 0; this.lastError = null;
    this.running = null; this.abort = null; this.closed = false; this.force = false; this.checking = false;
    this.startedAt = 0; this.finishedAt = 0; this.runId = null; this.work = null;
  }
  config() {
    return { ...this.runtime.config, ...this.record?.preferences,
      excludeSessionIds: [...new Set([...this.runtime.config.excludeSessionIds, ...this.runtime.archivedSessionIds()])] };
  }
  async start() {
    await this.read();
    this.work = await this.runtime.db.call('getState', 'memoryWork');
    if (this.work?.activeRequestId) {
      await this.runtime.db.call('finishMemoryRequest', this.work.activeRequestId, null, 'SUMMARY_INTERRUPTED');
      this.work.activeRequestId = null; this.work.failure = { code: 'SUMMARY_INTERRUPTED', time: Date.now() }; this.work.retryAt = 0;
      await this.persistWork();
    }
    this.runId = await this.runtime.db.call('getState', 'memoryLastRun');
    this.lastError = this.work?.failure || null; this.retryAt = this.work?.retryAt || 0;
    this.schedule();
  }
  schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => { this.kick().catch(error => this.runtime.recordError('memory', error)).finally(() => this.schedule()); }, 1000);
    this.timer.unref();
  }
  setGenerator(generator) { this.abort?.abort(); this.generator = generator; }
  observe(agent) { this.observeTarget(agent?.session?.requestHeader?.()?.config || agent?.options); }
  observeTarget(target) { if (target?.provider && target?.model) this.lastTarget = { provider: target.provider, model: target.model }; }
  markDirty() { this.lastDirtyAt = Date.now(); }
  invalidate() { this.abort?.abort(); this.markDirty(); }
  async read() {
    this.record = await this.runtime.db.call('readMemory');
    const config = this.config();
    return { ...this.record, preferences: Object.fromEntries(PREFERENCES.map(key => [key, config[key]])) };
  }
  async status() {
    const config = this.config(), counts = await this.runtime.db.call('memoryCounts', config);
    const target = this.generator?.selection?.();
    return { ...counts, revision: this.record?.revision || 0, updatedAt: this.record?.updatedAt || 0,
      autoUpdate: this.record?.autoUpdate ?? true, hasText: Boolean(this.record?.text), maxChars: config.memoryMaxChars,
      running: Boolean(this.running), phase: this.work?.phase || null, staged: Boolean(this.work?.entries),
      modelReady: Boolean(target), model: target?.model || null, provider: target?.provider || null,
      modelSelection: this.record?.modelSelection || null, preferences: Object.fromEntries(PREFERENCES.map(key => [key, config[key]])),
      nextUpdateAt: counts.oldestPendingAt ? counts.oldestPendingAt + config.memoryMaxWaitMs : null,
      usage: await this.runtime.db.call('memoryUsage', this.runId),
      startedAt: this.startedAt, finishedAt: this.finishedAt, retryAt: this.retryAt, lastError: this.lastError };
  }
  async save(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(k => !['text', 'autoUpdate', 'expectedRevision', 'modelSelection', 'preferences', 'lockedIds'].includes(k))
      || typeof payload.text !== 'string' || typeof payload.autoUpdate !== 'boolean'
      || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) throw fail('BAD_INPUT', '摘要设置格式无效');
    const preferences = payload.preferences;
    if (preferences !== undefined && (!preferences || Array.isArray(preferences) || typeof preferences !== 'object'
      || Object.keys(preferences).some(key => !PREFERENCES.includes(key)))) throw fail('BAD_INPUT', '摘要预算设置无效');
    let config;
    try { config = validateConfig({ ...this.config(), ...preferences }, {}); } catch { throw fail('BAD_INPUT', '摘要预算或等待时间超出允许范围'); }
    if (payload.text.length > config.memoryMaxChars) throw fail('BAD_INPUT', `摘要需为不超过 ${config.memoryMaxChars} 个字符的文本`);
    if (payload.lockedIds !== undefined && (!Array.isArray(payload.lockedIds) || payload.lockedIds.some(id => typeof id !== 'string'))) throw fail('BAD_INPUT');
    if (payload.modelSelection !== undefined && payload.modelSelection !== null) {
      const target = payload.modelSelection;
      if (typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(k => !['provider', 'model'].includes(k))
        || !['provider', 'model'].every(k => typeof target[k] === 'string' && target[k].trim() === target[k] && target[k].length > 0 && target[k].length <= 256)) throw fail('BAD_INPUT', '请选择 DSH 中已配置的摘要模型');
      if (!this.generator?.hasProvider?.(target.provider)) throw fail('NO_SUMMARY_MODEL', '该模型的服务商尚未在 DSH 中配置');
    }
    this.abort?.abort(); this.force = false;
    this.record = await this.runtime.db.call('saveMemory', payload.expectedRevision, payload.text, payload.autoUpdate, payload.modelSelection, preferences, payload.lockedIds);
    this.markDirty(); this.retryAt = 0; this.lastError = null;
    return this.read();
  }
  async restore(payload) {
    if (!payload || !Number.isSafeInteger(payload.expectedRevision) || !Number.isSafeInteger(payload.revision)) throw fail('BAD_INPUT');
    this.abort?.abort(); this.force = false;
    this.record = await this.runtime.db.call('restoreMemory', payload.expectedRevision, payload.revision, this.config().memoryMaxChars);
    this.markDirty(); return this.read();
  }
  requestUpdate() {
    if (this.running) return;
    if (!this.generator?.selection?.()) throw fail('NO_SUMMARY_MODEL', '请先在 DSH 中配置聊天模型');
    this.force = true; this.retryAt = 0; this.kick().catch(error => this.runtime.recordError('memory', error));
  }
  async kick() {
    if (this.closed || this.runtime.closed || this.running || this.checking) return;
    this.checking = true;
    this.checkFinished = new Promise(resolve => { this.resolveCheck = resolve; });
    try {
      if (!this.generator?.selection?.() || this.runtime.pumpRunning || this.runtime.scanRunning) return;
      await this.read();
      const config = this.config(), manual = this.force;
      if (!manual) {
        if (!this.record.autoUpdate || Date.now() - this.lastRunAt < config.memoryIntervalMs) return;
        const counts = await this.runtime.db.call('memoryCounts', config);
        if (!counts.pending && !this.work) return;
        if (!this.work && counts.pendingTokens < config.memoryTriggerTokens
          && Date.now() - counts.oldestPendingAt < config.memoryMaxWaitMs) return;
        if (!this.work && Date.now() - this.lastDirtyAt < config.memoryDebounceMs
          && Date.now() - counts.oldestPendingAt < config.memoryMaxWaitMs) return;
      }
      if (this.closed || this.runtime.closed) return;
      this.force = false; this.abort = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, this.runtime.stop.signal]);
      this.nextRunId = randomUUID();
      this.running = this.drain(signal, manual).catch(error => {
        if (!signal.aborted) { this.lastError = diagnostic(error); this.runtime.recordError('memory', error); }
      }).finally(() => { this.finishedAt = Date.now(); this.lastRunAt = Date.now(); this.running = null; this.abort = null; });
      await this.running;
    } finally { this.checking = false; this.resolveCheck?.(); }
  }
  async persistWork() { await this.runtime.db.call('setState', 'memoryWork', this.work); }
  async drain(signal, manual) {
    while (!signal.aborted && await this.updateBatch(signal, manual)) manual = false;
  }
  async updateBatch(signal, manual) {
    const previous = await this.read(), config = this.config(), target = this.generator.selection();
    signal.throwIfAborted();
    const contextWindow = await this.generator.contextWindow?.(target, signal);
    if (contextWindow) config.memoryContextTokens = Math.min(config.memoryContextTokens, contextWindow);
    const key = hash(JSON.stringify([target, config.memoryMaxChars, config.memoryMaxTokens, config.memoryContextTokens,
      config.memoryBatchTokens, config.memoryDailyTokens, config.memoryRetryLimit, MEMORY_INSTRUCTION, MEMORY_COMPACT_INSTRUCTION]));
    if (this.work && this.work.key !== key && !this.work.entries && !this.work.response) {
      this.work = null; await this.persistWork();
    }
    if (this.work && (this.work.baseRevision !== previous.revision
      || !await this.runtime.db.call('validMemoryReceipts', this.work.batch.receipts, config))) {
      if (this.work.baseRevision !== previous.revision && JSON.stringify(this.work.previous.entries) === JSON.stringify(previous.entries)
        && await this.runtime.db.call('validMemoryReceipts', this.work.batch.receipts, config)) {
        this.work.baseRevision = previous.revision; this.work.previous = previous;
      } else if (this.work.patch && await this.runtime.db.call('validMemoryReceipts', this.work.batch.receipts, config)) {
        const touched = this.work.patch.operations.filter(op => op.op !== 'add').map(op => op.id);
        const compatible = touched.every(id => JSON.stringify(previous.entries.find(entry => entry.id === id))
          === JSON.stringify(this.work.previous.entries.find(entry => entry.id === id)));
        if (!compatible) {
          if (manual) this.work = null;
          else {
            this.work.failure = { code: 'SUMMARY_EDIT_CONFLICT', time: Date.now() }; this.work.retryAt = 0;
            this.lastError = this.work.failure; await this.persistWork(); return false;
          }
        } else {
          this.work.entries = applyMemoryPatch(previous.entries, this.work.patch, this.work.batch.additions);
          this.work.previous = previous; this.work.baseRevision = previous.revision;
          this.work.compacted = false; this.work.failure = null; this.work.retryAt = 0;
        }
      } else this.work = null;
      await this.persistWork();
    }
    if (!this.work) {
      const base = summaryInput({ previous, maxChars: config.memoryMaxChars });
      const allowance = config.memoryContextTokens - config.memoryMaxTokens - estimateTokens(base.system + JSON.stringify(base.payload)) - 3000;
      if (allowance < 256) { this.lastError = diagnostic(fail('SUMMARY_CONTEXT_BUDGET')); return false; }
      const batch = await this.runtime.db.call('memoryBatch', config, Math.min(config.memoryBatchTokens, allowance));
      if (!batch.additions.length) { this.lastError = null; this.retryAt = 0; return false; }
      this.work = { baseRevision: previous.revision, previous, batch, key, phase: 'update', attempts: 0, failure: null, retryAt: 0 };
      await this.persistWork();
    }
    const work = this.work;
    if (manual || work.key !== key || (work.failure?.code === 'SUMMARY_DAILY_LIMIT' && work.day !== localDay())) {
      work.key = key; work.failure = null; work.retryAt = 0; work.attempts = 0;
      await this.persistWork();
    }
    if (work.failure && (!work.retryAt || Date.now() < work.retryAt)) {
      this.lastError = work.failure; this.retryAt = work.retryAt; return false;
    }
    this.startedAt = Date.now(); this.lastError = null;
    try {
      if (!work.entries) {
        const patch = await this.generate({ previous: work.previous, batch: work.batch, phase: 'update', target, config }, signal);
        signal.throwIfAborted();
        work.patch = patch;
        work.entries = applyMemoryPatch(work.previous.entries, patch, work.batch.additions);
        work.response = null;
        work.phase = 'commit'; work.attempts = 0; work.failure = null; work.retryAt = 0;
        await this.persistWork();
      }
      // Archive/deletion can happen while the model is responding. Discard the
      // staged result before spending on compaction or committing its receipts.
      if (!await this.runtime.db.call('validMemoryReceipts', work.batch.receipts, this.config())) {
        this.work = null; await this.persistWork(); return false;
      }
      const oldLength = renderMemory(work.previous.entries).length, length = renderMemory(work.entries).length;
      // Consolidate ordinary growth, including small updates well below capacity
      // and updates that start above the former 85% threshold. No-op/shrinking
      // patches need no second model call; first creation still has the hard cap.
      const needsCompact = length > config.memoryMaxChars || (oldLength > 0 && length > oldLength);
      if (needsCompact && !work.compacted) {
        work.phase = 'compact'; await this.persistWork();
        const patch = await this.generate({ previous: { ...work.previous, entries: work.entries }, batch: { additions: [], context: [] }, phase: 'compact', target, config }, signal);
        signal.throwIfAborted();
        work.entries = applyMemoryPatch(work.entries, patch, [], { compact: true });
        work.response = null;
        work.compacted = true; work.phase = 'commit'; work.attempts = 0;
        await this.persistWork();
      }
      if (renderMemory(work.entries).length > config.memoryMaxChars) throw fail('SUMMARY_CAPACITY', '摘要容量不足，已暂存本批变更');
      signal.throwIfAborted();
      const saved = await this.runtime.db.call('commitMemoryDocument', work.baseRevision, work.entries, work.batch.receipts, this.config());
      this.work = null;
      if (!saved) { await this.persistWork(); await this.read(); return false; }
      this.record = saved; this.lastError = null; this.retryAt = 0;
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      work.failure = { ...diagnostic(error), maxTokens: config.memoryMaxTokens };
      if (error.code === 'SUMMARY_DAILY_LIMIT') { work.day = localDay(); work.retryAt = 0; }
      else {
        work.attempts++;
        work.retryAt = transient(error) && work.attempts <= config.memoryRetryLimit ? Date.now() + 60000 * 2 ** (work.attempts - 1) : 0;
      }
      this.lastError = work.failure; this.retryAt = work.retryAt;
      await this.persistWork(); return false;
    }
  }
  async generate(input, runSignal) {
    const { config } = input;
    const responseKey = hash(JSON.stringify([input.phase, input.previous.entries]));
    if (this.work?.response?.key === responseKey) return this.work.response.patch;
    const request = summaryInput({ ...input, maxChars: config.memoryMaxChars });
    const inputEstimate = estimateTokens(request.system + JSON.stringify(request.payload)) + 512;
    if (inputEstimate + config.memoryMaxTokens > config.memoryContextTokens) throw fail('SUMMARY_CONTEXT_BUDGET', '摘要请求超出配置的上下文预算');
    const id = await this.runtime.db.call('reserveMemoryRequest', { runId: this.nextRunId, phase: input.phase,
      provider: input.target.provider, model: input.target.model, reserved: inputEstimate + config.memoryMaxTokens }, config.memoryDailyTokens);
    this.runId = this.nextRunId; await this.runtime.db.call('setState', 'memoryLastRun', this.runId);
    this.work.activeRequestId = id; await this.persistWork();
    const signal = AbortSignal.any([runSignal, AbortSignal.timeout(config.memoryTimeoutMs)]);
    let onAbort, usage = null, errorCode = null, settled = false;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(fail('ABORTED', '摘要更新已取消或超时'));
      signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([this.generator.generate({ ...input, maxChars: config.memoryMaxChars, maxTokens: config.memoryMaxTokens,
        signal, onUsage: value => { if (!settled && value) usage = { ...usage, ...value }; } }), cancelled]);
      signal.throwIfAborted();
      const patch = parsePatch(result);
      applyMemoryPatch(input.previous.entries, patch, input.batch.additions, { compact: input.phase === 'compact' });
      this.work.response = { key: responseKey, patch };
      return patch;
    } catch (error) {
      errorCode = diagnostic(error).code;
      this.work.failure = runSignal.aborted ? { code: 'SUMMARY_INTERRUPTED', time: Date.now() } : diagnostic(error);
      this.work.retryAt = 0;
      throw error;
    }
    finally {
      settled = true; signal.removeEventListener('abort', onAbort);
      if (this.work?.activeRequestId === id) this.work.activeRequestId = null;
      await this.runtime.db.call('finishMemoryRequest', id, usage, errorCode, this.work);
    }
  }
  message(session) {
    if (!this.record?.text || session?.requestHeader?.()
      || typeof session?.eventAt !== 'function' || typeof session.append !== 'function') return null;
    const text = `${MEMORY_INTRO}\n${this.record.text}`;
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'history-rag-memory', form: 'summary', revision: this.record.revision, bodyHash: hash(text) } };
  }
  retire(session, turn, step) {
    if (this.closed || this.runtime.closed || typeof session?.eventAt !== 'function' || typeof session.append !== 'function') return;
    try {
      for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (event?.type !== 'user/message' || event.data.source?.kind !== 'history-rag-memory') continue;
        const message = { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } };
        session.append('system/message', { turn, step, message }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        });
      }
    } catch (error) { this.runtime.recordError('summary-retire', error); }
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.abort?.abort(); await this.running; await this.checkFinished; }
}
