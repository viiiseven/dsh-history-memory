import { hash } from './text.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serviceEndpoints } from './endpoints.js';

export class EmbeddingError extends Error {
  constructor(code, message) { super(message); this.name = 'EmbeddingError'; this.code = code; }
}

export function normalizeVector(values) {
  if (!Array.isArray(values) || !values.length || values.length > 65536 || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new EmbeddingError('INVALID_VECTOR', 'Embedding 返回了无效向量');
  }
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError('INVALID_VECTOR', 'Embedding 返回了零向量或无效向量');
  return Float32Array.from(values, v => v / norm);
}

export class EmbeddingClient {
  constructor(config, { fetch = globalThis.fetch, env = process.env, apiKey } = {}) {
    this.config = config; this.fetch = fetch; this.env = env; this.apiKey = apiKey;
    this.endpoint = serviceEndpoints(config.embeddingEndpoint).embedding;
    // Keys never become part of the persisted model identity.
    this.identity = hash(JSON.stringify([this.endpoint, config.embeddingModel, config.dimensions, config.documentPrefix, config.queryPrefix]));
  }
  get configured() { return Boolean(this.config.embeddingEndpoint && this.config.embeddingModel); }
  async requestJSON(url, { method = 'GET', body, signal, timeoutMs } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    let key = this.apiKey === undefined ? this.env[this.config.apiKeyEnv] : this.apiKey;
    if (this.apiKey === undefined && !key && this.config.apiKeyFile) {
      try { key = (await readFile(resolve(this.config.dataDir, this.config.apiKeyFile), 'utf8')).trim(); }
      catch { throw new EmbeddingError('KEY_FILE_ERROR', '无法读取本地 Embedding Key 文件'); }
    }
    if (key) headers.Authorization = `Bearer ${key}`;
    const deadline = AbortSignal.timeout(timeoutMs || this.config.embeddingTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    if (combined.aborted) throw new EmbeddingError('ABORTED', 'Embedding 请求已取消或超时');
    let response;
    try {
      response = await this.fetch(url, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: combined, redirect: 'error',
      });
    } catch (error) {
      if (combined.aborted) throw new EmbeddingError('ABORTED', 'Embedding 请求已取消或超时');
      throw new EmbeddingError('NETWORK_ERROR', 'Embedding 服务连接失败');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EmbeddingError(`HTTP_${response.status}`, `Embedding 服务返回 HTTP ${response.status}`);
    }
    try { return await response.json(); }
    catch { throw new EmbeddingError(combined.aborted ? 'ABORTED' : 'INVALID_RESPONSE', combined.aborted ? 'Embedding 请求已取消或超时' : 'Embedding 服务返回了无效 JSON'); }
  }
  async embed(texts, { query = false, signal, timeoutMs } = {}) {
    if (!this.configured) throw new EmbeddingError('NOT_CONFIGURED', '请先配置 Embedding 地址和模型');
    const prefix = query ? this.config.queryPrefix : this.config.documentPrefix;
    const body = { model: this.config.embeddingModel, input: texts.map(t => prefix + t), encoding_format: 'float' };
    if (this.config.dimensions) body.dimensions = this.config.dimensions;
    const data = await this.requestJSON(this.endpoint, { method: 'POST', body, signal, timeoutMs });
    if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new EmbeddingError('INVALID_RESPONSE', 'Embedding 返回条数不匹配');
    const ordered = new Array(texts.length);
    for (const item of data.data) {
      if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || ordered[item.index]) {
        throw new EmbeddingError('INVALID_RESPONSE', 'Embedding 返回了重复或无效索引');
      }
      ordered[item.index] = normalizeVector(item.embedding);
    }
    const dim = ordered[0]?.length;
    if (!dim || ordered.some(v => !v || v.length !== dim) || (this.config.dimensions && dim !== this.config.dimensions)) {
      throw new EmbeddingError('DIMENSION_MISMATCH', 'Embedding 向量维度不一致');
    }
    return ordered;
  }
}
