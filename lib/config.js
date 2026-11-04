import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export const NAME = 'history-rag';
export const DEFAULTS = Object.freeze({
  embeddingEndpoint: '', embeddingModel: '', apiKeyEnv: 'HISTORY_RAG_API_KEY', apiKeyFile: '',
  dimensions: 0, queryPrefix: '', documentPrefix: '',
  chunkChars: 800, chunkOverlap: 120, batchSize: 10,
  scanIntervalMs: 60000, embeddingTimeoutMs: 30000, recallTimeoutMs: 3000,
  topK: 3, minScore: 0.35, maxContextChars: 6000, queryMaxChars: 4000,
  scope: 'all', excludeSessionIds: [], excludeWorkspaces: [],
  humanSourceKinds: ['user', 'prompt'], includeToolResults: false,
  memoryMaxChars: 6000, memoryInputChars: 16000, memoryMaxTokens: 16000,
  memoryDebounceMs: 30000, memoryIntervalMs: 60000, memoryTimeoutMs: 120000,
  updateCheckEnabled: true, updateCheckIntervalMs: 21600000, updateCheckTimeoutMs: 10000,
});

function integer(v, key, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
}

export function resolveConfig(input = {}, env = process.env) {
  const dataDir = resolve(input.dataDir || env.HISTORY_RAG_DATA_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'history-rag'));
  const configFile = resolve(input.configFile || env.HISTORY_RAG_CONFIG || join(dataDir, 'config.json'));
  let file = {};
  try { file = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取配置文件 ${configFile}`, { cause: error }); }
  return validateConfig({ ...DEFAULTS, ...file, ...input, dataDir, configFile }, env);
}

export function validateConfig(value, env = process.env) {
  const c = { ...value };
  c.embeddingEndpoint = env.HISTORY_RAG_ENDPOINT || c.embeddingEndpoint;
  c.embeddingModel = env.HISTORY_RAG_MODEL || c.embeddingModel;
  for (const key of ['embeddingEndpoint', 'embeddingModel', 'apiKeyEnv', 'apiKeyFile', 'queryPrefix', 'documentPrefix']) {
    if (typeof c[key] !== 'string') throw new Error(`${key} 必须是字符串`);
  }
  if (c.embeddingEndpoint) {
    const url = new URL(c.embeddingEndpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Embedding 地址必须是 HTTP(S) URL，不可包含用户名、密码或片段');
    c.embeddingEndpoint = url.href;
  }
  for (const [key, min, max] of [
    ['dimensions', 0, 65536], ['chunkChars', 64, 16000], ['chunkOverlap', 0, 15999],
    ['batchSize', 1, 256], ['scanIntervalMs', 1000, 86400000], ['embeddingTimeoutMs', 100, 300000],
    ['recallTimeoutMs', 100, 60000], ['topK', 1, 50], ['maxContextChars', 512, 100000], ['queryMaxChars', 64, 32000],
    ['memoryMaxChars', 256, 20000], ['memoryInputChars', 16000, 128000], ['memoryMaxTokens', 256, 16000],
    ['memoryDebounceMs', 0, 3600000], ['memoryIntervalMs', 1000, 86400000], ['memoryTimeoutMs', 100, 300000],
    ['updateCheckIntervalMs', 60000, 604800000], ['updateCheckTimeoutMs', 100, 60000],
  ]) integer(c[key], key, min, max);
  if (c.chunkOverlap >= c.chunkChars) throw new Error('chunkOverlap 必须小于 chunkChars');
  if (!Number.isFinite(c.minScore) || c.minScore < -1 || c.minScore > 1) throw new Error('minScore 必须在 -1 到 1 之间');
  if (!['all', 'workspace'].includes(c.scope)) throw new Error('scope 必须为 all 或 workspace');
  for (const key of ['excludeSessionIds', 'excludeWorkspaces', 'humanSourceKinds']) {
    if (!Array.isArray(c[key]) || c[key].some(v => typeof v !== 'string')) throw new Error(`${key} 必须是字符串数组`);
  }
  if (typeof c.includeToolResults !== 'boolean') throw new Error('includeToolResults 必须是布尔值');
  if (typeof c.updateCheckEnabled !== 'boolean') throw new Error('updateCheckEnabled 必须是布尔值');
  return c;
}
