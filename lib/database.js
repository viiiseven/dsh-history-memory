import { Worker } from 'node:worker_threads';

export class Database {
  constructor(path, { ownerToken } = {}) {
    this.pending = new Map(); this.nextId = 1; this.closed = false;
    this.worker = new Worker(new URL('./db-worker.js', import.meta.url), {
      workerData: { path, ownerToken }, execArgv: [],
    });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.worker.on('message', m => {
      if (m.ready) { this.resolveReady(); return; }
      const task = this.pending.get(m.id);
      if (!task) return;
      this.pending.delete(m.id);
      if (m.error) task.reject(Object.assign(new Error(m.error), { code: m.code })); else task.resolve(m.value);
    });
    const fail = error => { this.closed = true; this.rejectReady(error); for (const task of this.pending.values()) task.reject(error); this.pending.clear(); };
    this.worker.on('error', fail);
    this.worker.on('exit', code => { if (!this.closed || code) fail(new Error(`数据库线程已退出 (${code})`)); });
  }
  async call(method, ...args) {
    await this.ready;
    if (this.closed) throw new Error('数据库已关闭');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  async search(model, vector, options, signal) {
    return this.cancellableSearch('search', [model, vector], options, signal);
  }
  async keywordSearch(query, options, signal) {
    return this.cancellableSearch('keywordSearch', [query], options, signal);
  }
  async cancellableSearch(method, args, options, signal) {
    await this.ready;
    if (signal?.aborted) throw signal.reason;
    const cancelBuffer = new SharedArrayBuffer(4);
    const flag = new Int32Array(cancelBuffer);
    const abort = () => Atomics.store(flag, 0, 1);
    signal?.addEventListener('abort', abort, { once: true });
    try { return await this.call(method, ...args, { ...options, cancelBuffer }); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async close() {
    if (this.closed) return;
    try { await this.call('close'); }
    finally { this.closed = true; await this.worker.terminate(); }
  }
}
