import { readFile, writeFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './text.js';
import { validateConfig } from './config.js';
import { EmbeddingClient } from './embedding.js';
import { serviceEndpoints } from './endpoints.js';
import { discoverModels } from './models.js';
import { MemoryError } from './memory.js';

const MANAGED_KEY = /^embedding-ui-[a-f0-9-]+\.key$/;
const EDIT_FIELDS = ['embeddingEndpoint', 'embeddingModel', 'apiKey', 'clearApiKey', 'expectedRevision'];

export class SettingsError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; }
}

async function documentAt(path) {
  let text = '';
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new SettingsError('CONFIG_READ_FAILED', '无法读取配置文件'); }
  let value;
  try { value = text ? JSON.parse(text) : {}; }
  catch { throw new SettingsError('CONFIG_INVALID', '配置文件不是有效 JSON，请先修复后重试'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('CONFIG_INVALID', '配置文件必须是对象');
  return { value, revision: hash(text) };
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export class SettingsController {
  constructor(runtime, input = {}, { env = process.env, clientFactory = (config, options = {}) => new EmbeddingClient(config, { env, ...options }), persist = atomicWrite } = {}) {
    this.runtime = runtime; this.env = env; this.input = input;
    this.clientFactory = clientFactory; this.persist = persist; this.writes = Promise.resolve();
  }
  locks() {
    const c = this.runtime.config;
    return {
      embeddingEndpoint: Boolean(this.env.HISTORY_RAG_ENDPOINT || Object.hasOwn(this.input, 'embeddingEndpoint')),
      embeddingModel: Boolean(this.env.HISTORY_RAG_MODEL || Object.hasOwn(this.input, 'embeddingModel')),
      apiKey: Boolean(this.env[c.apiKeyEnv] || Object.hasOwn(this.input, 'apiKeyFile')),
    };
  }
  async keyState() {
    const c = this.runtime.config;
    if (this.env[c.apiKeyEnv]) return { configured: true, source: 'environment' };
    if (c.apiKeyFile) {
      try {
        const file = await stat(resolve(c.dataDir, c.apiKeyFile));
        if (file.isFile() && file.size) return { configured: true, source: 'file' };
      } catch {}
    }
    return { configured: false, source: 'none' };
  }
  async read() {
    const doc = await documentAt(this.runtime.config.configFile);
    return { embeddingEndpoint: this.runtime.config.embeddingEndpoint, embeddingModel: this.runtime.config.embeddingModel,
      key: await this.keyState(), locks: this.locks(), revision: doc.revision };
  }
  validate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(k => !EDIT_FIELDS.includes(k))) throw new SettingsError('BAD_INPUT', '设置参数无效');
    for (const [key, max] of [['embeddingEndpoint', 4096], ['embeddingModel', 256], ['apiKey', 16384], ['expectedRevision', 64]]) {
      if (payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > max)) throw new SettingsError('BAD_INPUT', '设置内容过长或格式无效');
    }
    if (payload.clearApiKey !== undefined && typeof payload.clearApiKey !== 'boolean') throw new SettingsError('BAD_INPUT', 'Key 设置无效');
    const locks = this.locks();
    for (const key of ['embeddingEndpoint', 'embeddingModel']) {
      if (locks[key] && payload[key] !== undefined && payload[key].trim() !== this.runtime.config[key]) throw new SettingsError('SETTING_LOCKED', '该设置由环境变量或插件配置提供，请先移除对应覆盖');
    }
    if (locks.apiKey && (payload.apiKey?.trim() || payload.clearApiKey)) throw new SettingsError('SETTING_LOCKED', 'Key 由环境变量提供，无法在此替换或清除');
    if (payload.apiKey?.trim() && payload.clearApiKey) throw new SettingsError('BAD_INPUT', '不能同时填写和清除 Key');
    let candidate;
    try {
      candidate = validateConfig({ ...this.runtime.config,
        embeddingEndpoint: payload.embeddingEndpoint?.trim() ?? this.runtime.config.embeddingEndpoint,
        embeddingModel: payload.embeddingModel?.trim() ?? this.runtime.config.embeddingModel,
      }, this.env);
    } catch { throw new SettingsError('BAD_INPUT', '接口地址或模型设置无效，请填写 HTTP(S) 基础地址或完整 Embedding 请求地址'); }
    return candidate;
  }
  save(payload) {
    const operation = this.writes.then(() => this.commit(payload));
    this.writes = operation.catch(() => {});
    return operation;
  }
  async commit(payload) {
    const candidate = this.validate(payload);
    const previous = this.runtime.config;
    const doc = await documentAt(previous.configFile);
    if (payload.expectedRevision !== doc.revision) throw new SettingsError('SETTINGS_CONFLICT', '设置已在其他窗口修改，请重新加载设置后再保存');
    let createdKey;
    const updated = { ...doc.value };
    for (const key of ['embeddingEndpoint', 'embeddingModel']) if (!this.locks()[key]) updated[key] = candidate[key];
    try {
      if (payload.apiKey?.trim()) {
        createdKey = `embedding-ui-${randomUUID()}.key`;
        await atomicWrite(join(candidate.dataDir, createdKey), payload.apiKey.trim());
        candidate.apiKeyFile = createdKey; updated.apiKeyFile = createdKey;
      } else if (payload.clearApiKey) {
        candidate.apiKeyFile = ''; updated.apiKeyFile = '';
      }
      // Each Key generation has its own file, so in-flight requests to an old
      // endpoint cannot accidentally read a newly saved endpoint's credential.
      const current = await documentAt(previous.configFile);
      if (current.revision !== doc.revision) throw new SettingsError('SETTINGS_CONFLICT', '设置已在其他窗口修改，请重新加载设置后再保存');
      if (this.runtime.closed) throw new SettingsError('UNAVAILABLE', '插件已关闭');
      await this.persist(previous.configFile, `${JSON.stringify(updated, null, 2)}\n`);
    } catch (error) {
      if (createdKey) await unlink(join(candidate.dataDir, createdKey)).catch(() => {});
      if (error instanceof SettingsError) throw error;
      throw new SettingsError('SAVE_FAILED', '保存失败，请检查配置目录的写入权限', { cause: error });
    }
    this.runtime.reconfigure(candidate);
    if (previous.apiKeyFile !== candidate.apiKeyFile && MANAGED_KEY.test(previous.apiKeyFile)) {
      await unlink(join(previous.dataDir, previous.apiKeyFile)).catch(() => {});
    }
    return this.read();
  }
  draftClient(candidate, payload) {
    const options = {};
    if (payload.apiKey?.trim()) options.apiKey = payload.apiKey.trim();
    else if (payload.clearApiKey) options.apiKey = '';
    return this.clientFactory(candidate, options);
  }
  async models(payload, signal) {
    const candidate = this.validate(payload);
    if (!candidate.embeddingEndpoint) throw new SettingsError('NOT_CONFIGURED', '请先填写接口地址和 Key（如需要）');
    try { return await discoverModels(this.draftClient(candidate, payload), { signal }); }
    catch (error) {
      const messages = { HTTP_401: '鉴权失败，请检查 Key', HTTP_403: '模型列表访问被拒绝，请检查 Key 权限或手动填写模型',
        ABORTED: '获取模型列表已取消或超时，请重试或手动填写模型', KEY_FILE_ERROR: '无法读取本地 Key 文件',
        HTTP_429: '模型列表接口限流，请稍后重试' };
      throw new SettingsError('MODELS_FAILED', messages[error.code] || '未能获取模型列表，服务可能未开放此接口。你仍可手动填写模型后测试连接。');
    }
  }
  async test(payload, signal) {
    const candidate = this.validate(payload);
    if (!candidate.embeddingEndpoint || !candidate.embeddingModel) throw new SettingsError('NOT_CONFIGURED', '请先填写接口地址和模型');
    const client = this.draftClient(candidate, payload);
    const begin = Date.now();
    try {
      const vectors = await client.embed(['Embedding 连接测试'], { signal, timeoutMs: 10000 });
      return { dimensions: vectors[0].length, elapsedMs: Date.now() - begin, endpoint: serviceEndpoints(candidate.embeddingEndpoint).embedding };
    } catch (error) {
      const messages = { HTTP_401: '鉴权失败，请检查 Key', HTTP_403: '接口拒绝访问，请检查 Key 权限', HTTP_404: '请求路径不存在，或该模型不支持当前 Embedding 接口。请核对地址和模型。', HTTP_429: '接口限流或额度不足，请稍后重试', ABORTED: '连接测试已取消或超时', DIMENSION_MISMATCH: '接口返回的向量维度与配置不一致', KEY_FILE_ERROR: '无法读取本地 Key 文件' };
      throw new SettingsError('CONNECTION_TEST_FAILED', messages[error.code] || '连接测试失败，请检查地址、模型和服务状态');
    }
  }
}

export function registerSettings(ctx, controller) {
  for (const action of ['settings', 'save', 'test', 'models', 'status', 'scan', 'memory', 'memory-save', 'memory-update', 'updates-check']) {
    const endpoint = `history-rag/${action}`;
    ctx.connection.fetch.register({ path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let message;
        try { message = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length > 200 || message.method !== endpoint) return new Response('Invalid request', { status: 400 });
        let result;
        try {
          let value;
          if (action === 'settings') value = await controller.read();
          else if (action === 'save') value = await controller.save(message.payload);
          else if (action === 'test') value = await controller.test(message.payload, request.signal);
          else if (action === 'models') value = await controller.models(message.payload, request.signal);
          else if (action === 'memory') value = await controller.runtime.memory.read();
          else if (action === 'memory-save') value = await controller.runtime.memory.save(message.payload);
          else if (action === 'memory-update') { controller.runtime.memory.requestUpdate(); value = await controller.runtime.memory.status(); }
          else if (action === 'updates-check') value = await controller.runtime.updates.check({ manual: true });
          else if (action === 'status') value = await controller.runtime.status();
          else { await controller.runtime.scan(); value = await controller.runtime.status(); }
          result = { ok: true, value };
        } catch (error) {
          const known = error instanceof SettingsError || error instanceof MemoryError;
          result = { ok: false, error: { code: known ? error.code : 'UNAVAILABLE',
            message: known ? error.message : '操作失败，请稍后重试', details: {} } };
        }
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
      },
    });
  }
}
