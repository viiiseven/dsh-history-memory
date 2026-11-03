import { serviceEndpoints } from './endpoints.js';
import { EmbeddingError } from './embedding.js';

function modelInfo(item) {
  const id = typeof item === 'string' ? item : item?.id ?? item?.model;
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f]/.test(id)) return null;
  const capabilities = Array.isArray(item?.capabilities) ? item.capabilities : [];
  const likelyEmbedding = capabilities.includes('TR') || /embed|(?:^|[/_-])(?:bge|e5|gte)(?:[/_-]|$)/i.test(id);
  return { id: id.trim(), likelyEmbedding };
}

export async function discoverModels(client, { signal, timeoutMs = 10000 } = {}) {
  const endpoints = serviceEndpoints(client.config.embeddingEndpoint);
  if (!endpoints.models) throw new EmbeddingError('MODELS_UNSUPPORTED', '无法从此自定义请求地址推导模型列表');
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let endpoint = endpoints.models, cursor = '', seen = new Set(), rowsRead = 0;
  const models = new Map();
  for (let page = 1; page <= 20; page++) {
    const url = new URL(endpoint);
    if (endpoint === endpoints.modelsFallback) {
      url.searchParams.set('page_no', String(page)); url.searchParams.set('page_size', '100');
    } else if (cursor) url.searchParams.set('after', cursor);
    let data;
    try { data = await client.requestJSON(url.href, { signal: combined, timeoutMs }); }
    catch (error) {
      if (page === 1 && endpoint !== endpoints.modelsFallback && endpoints.modelsFallback
        && ['HTTP_404', 'HTTP_405', 'HTTP_501'].includes(error.code)) {
        endpoint = endpoints.modelsFallback; page = 0; continue;
      }
      throw error;
    }
    const rows = Array.isArray(data?.data) ? data.data : data?.output?.models;
    if (!Array.isArray(rows)) throw new EmbeddingError('INVALID_RESPONSE', '服务未返回有效模型列表');
    for (const row of rows) { const item = modelInfo(row); if (item) models.set(item.id, item); }
    rowsRead += rows.length;
    const nativeMore = endpoint === endpoints.modelsFallback && Number.isFinite(data.output?.total) && rowsRead < data.output.total;
    const more = nativeMore || data.has_more === true;
    if (!more || !rows.length) return result(false);
    const next = data.last_id || modelInfo(rows.at(-1))?.id;
    if (endpoint !== endpoints.modelsFallback) {
      if (!next || seen.has(next)) throw new EmbeddingError('INVALID_RESPONSE', '模型列表分页无效');
      seen.add(next); cursor = next;
    }
  }
  return result(true);

  function result(truncated) {
    return { endpoint, models: [...models.values()].sort((a, b) => Number(b.likelyEmbedding) - Number(a.likelyEmbedding) || a.id.localeCompare(b.id)), truncated };
  }
}
