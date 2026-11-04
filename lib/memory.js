import { randomUUID } from 'node:crypto';
import { hash, textBlocks } from './text.js';
import { MEMORY_INSTRUCTION, MEMORY_INTRO } from './memory-prompts.js';

const MEMORY_BATCH_SIZE = 8;
const REMEMBERED_TRUNCATIONS = 32;

export class MemoryError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class MemorySummary {
  constructor(runtime) {
    this.runtime = runtime; this.record = null; this.generator = null; this.lastTarget = null;
    this.lastDirtyAt = Date.now(); this.lastRunAt = 0; this.retryAt = 0; this.lastError = null;
    this.running = null; this.abort = null; this.closed = false; this.force = false;
    this.startedAt = 0; this.finishedAt = 0;
    this.truncations = [];
  }
  async start(truncations) {
    if (Array.isArray(truncations)) this.truncations = truncations.slice(-REMEMBERED_TRUNCATIONS);
    this.record = await this.runtime.db.call('readMemory');
    this.schedule();
  }
  schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => { this.kick().finally(() => this.schedule()); }, 1000);
    this.timer.unref();
  }
  setGenerator(generator) { this.abort?.abort(); this.generator = generator; }
  observe(agent) {
    const target = agent?.session?.requestHeader?.()?.config || agent?.options;
    this.observeTarget(target);
  }
  observeTarget(target) {
    if (target?.provider && target?.model) this.lastTarget = { provider: target.provider, model: target.model };
  }
  markDirty() { this.lastDirtyAt = Date.now(); }
  invalidate() { this.abort?.abort(); this.markDirty(); }
  async read() { this.record = await this.runtime.db.call('readMemory'); return this.record; }
  async status() {
    const counts = await this.runtime.db.call('memoryCounts', this.runtime.config);
    const target = this.generator?.selection?.();
    return { ...counts, revision: this.record?.revision || 0, updatedAt: this.record?.updatedAt || 0,
      autoUpdate: this.record?.autoUpdate ?? true, hasText: Boolean(this.record?.text), maxChars: this.runtime.config.memoryMaxChars,
      running: Boolean(this.running), modelReady: Boolean(target), model: target?.model || null,
      provider: target?.provider || null, modelSelection: this.record?.modelSelection || null,
      startedAt: this.startedAt, finishedAt: this.finishedAt, retryAt: this.retryAt, lastError: this.lastError };
  }
  async save(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(k => !['text', 'autoUpdate', 'expectedRevision', 'modelSelection'].includes(k))
      || typeof payload.text !== 'string' || payload.text.length > this.runtime.config.memoryMaxChars
      || typeof payload.autoUpdate !== 'boolean' || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) {
      throw new MemoryError('BAD_INPUT', `摘要需为不超过 ${this.runtime.config.memoryMaxChars} 个字符的文本`);
    }
    if (payload.modelSelection !== undefined && payload.modelSelection !== null) {
      const target = payload.modelSelection;
      if (typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(k => !['provider', 'model'].includes(k))
        || !['provider', 'model'].every(k => typeof target[k] === 'string' && target[k].trim() === target[k] && target[k].length > 0 && target[k].length <= 256)) {
        throw new MemoryError('BAD_INPUT', '请选择 DSH 中已配置的摘要模型');
      }
      if (!this.generator?.hasProvider?.(target.provider)) throw new MemoryError('NO_SUMMARY_MODEL', '该模型的服务商尚未在 DSH 中配置，请刷新模型列表后重试。');
    }
    this.abort?.abort(); this.force = false;
    try { this.record = await this.runtime.db.call('saveMemory', payload.expectedRevision, payload.text, payload.autoUpdate, payload.modelSelection); }
    catch (error) { if (error.code === 'MEMORY_CONFLICT') throw new MemoryError('MEMORY_CONFLICT', '摘要已在后台或其他窗口更新。请先复制草稿，再重新加载摘要后保存。'); throw error; }
    this.lastDirtyAt = Date.now(); this.retryAt = 0; this.lastError = null;
    return this.record;
  }
  requestUpdate() {
    if (this.running) return;
    if (!this.generator?.selection?.()) throw new MemoryError('NO_SUMMARY_MODEL', '请先在 DSH 中配置默认聊天模型，或在选好模型的会话中发送一条消息。');
    this.force = true; this.retryAt = 0; this.kick();
  }
  async kick() {
    if (this.closed || this.runtime.closed || this.running) return;
    if (Date.now() < this.retryAt) return;
    if (!this.force && (!this.record?.autoUpdate
      || Date.now() - this.lastDirtyAt < this.runtime.config.memoryDebounceMs
      || Date.now() - this.lastRunAt < this.runtime.config.memoryIntervalMs)) return;
    if (!this.generator?.selection?.() || this.runtime.pumpRunning || this.runtime.scanRunning) return;
    const manual = this.force;
    this.force = false;
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, this.runtime.stop.signal]);
    this.running = this.drain(signal, manual).catch(error => {
      if (signal.aborted) return;
      // Native failures may contain URLs, credentials or response bodies in the
      // message/cause. Retain only bounded codes and HTTP status for diagnostics.
      const status = error.status ?? error.failure?.status;
      this.lastError = { code: typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'SUMMARY_FAILED', time: Date.now(),
        ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}) };
      this.retryAt = Date.now() + 60000;
    }).finally(() => { this.finishedAt = Date.now(); this.running = null; this.abort = null; });
    await this.running;
  }
  async drain(signal, manual) {
    while (!signal.aborted && await this.updateBatch(signal, manual)) {
      // One explicit retry may bypass the guard on the first batch only.
      manual = false;
    }
  }
  async updateBatch(runSignal, manual) {
    const candidates = await this.runtime.db.call('pendingMemory', this.runtime.config, MEMORY_BATCH_SIZE);
    if (runSignal.aborted) return false;
    if (!candidates.length) { this.lastRunAt = Date.now(); return false; }
    const chunks = []; let size = 0;
    for (const chunk of candidates) {
      // Chunk offsets count source code points. The configured input budget
      // accepts at least one maximum-size indexed fragment.
      const cost = chunk.end - chunk.start;
      if (size + cost > this.runtime.config.memoryInputChars) break;
      chunks.push(chunk); size += cost;
    }
    if (!chunks.length) throw new MemoryError('SUMMARY_INPUT_TOO_LARGE', '原文片段超出摘要批次的输入上限');
    const previous = await this.read();
    if (runSignal.aborted) return false;
    const generator = this.generator;
    const target = generator.selection();
    const { memoryMaxChars: maxChars, memoryMaxTokens: maxTokens } = this.runtime.config;
    const key = hash(JSON.stringify([target?.provider, target?.model, maxChars, maxTokens, MEMORY_INSTRUCTION,
      previous.text, chunks.map(({ hash, role }) => [hash, role])]));
    const blocked = this.truncations.find(entry => entry?.key === key);
    if (blocked && !manual) {
      this.lastError = { code: 'SUMMARY_TRUNCATED', time: blocked.time, maxTokens };
      this.lastRunAt = Date.now();
      return false;
    }
    this.startedAt = Date.now(); this.lastError = null;
    const signal = AbortSignal.any([runSignal, AbortSignal.timeout(this.runtime.config.memoryTimeoutMs)]);
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(Object.assign(new Error('摘要更新已取消或超时'), { code: 'ABORTED' }));
      signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    try {
      let text;
      try {
        text = await Promise.race([generator.generate({ previous, chunks, maxChars, maxTokens, target, signal }), cancelled]);
      } catch (error) {
        if (error.code !== 'SUMMARY_TRUNCATED') throw error;
        signal.throwIfAborted();
        const time = Date.now();
        this.truncations = [...this.truncations.filter(entry => entry?.key !== key), { key, time }].slice(-REMEMBERED_TRUNCATIONS);
        await this.runtime.db.call('setState', 'memoryTruncations', this.truncations);
        if (runSignal.aborted) return false;
        this.lastError = { code: 'SUMMARY_TRUNCATED', time, maxTokens };
        this.lastRunAt = time;
        return false;
      }
      signal.throwIfAborted();
      if (typeof text !== 'string' || !text.trim()) throw new MemoryError('SUMMARY_EMPTY', '摘要模型没有返回正文');
      if (text.length > maxChars) throw new MemoryError('SUMMARY_TOO_LONG', '生成的摘要超过长度限制');
      const saved = await this.runtime.db.call('commitMemory', previous.revision, text.trim(), chunks.map(c => c.hash));
      if (saved) this.record = saved; else await this.read();
      this.lastError = null; this.retryAt = 0; this.lastRunAt = Date.now();
      return Boolean(saved);
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  message(agent, proposed = []) {
    if (!this.record?.text) return null;
    const visible = agent?.session?.deriveMessages?.() || [];
    if ([...visible, ...proposed].some(m => m?.source?.kind === 'history-rag-memory'
      && m.source.bodyHash === hash(textBlocks(m.content)))) return null;
    const text = `${MEMORY_INTRO}\n${this.record.text}`;
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'history-rag-memory', form: 'summary', revision: this.record.revision, bodyHash: hash(text) } };
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.abort?.abort(); await this.running; }
}
