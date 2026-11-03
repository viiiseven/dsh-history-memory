import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EmbeddingClient } from '../lib/embedding.js';
import { serviceEndpoints } from '../lib/endpoints.js';
import { discoverModels } from '../lib/models.js';
import { tempConfig } from './helpers.js';

test('SDK base URLs and complete URLs resolve consistently; custom endpoints stay intact', () => {
  for (const base of ['https://example.com/v1', 'https://example.com/v1/']) {
    assert.equal(serviceEndpoints(base).embedding, 'https://example.com/v1/embeddings');
    assert.equal(serviceEndpoints(base).models, 'https://example.com/v1/models');
  }
  assert.equal(serviceEndpoints('http://localhost:11434').embedding, 'http://localhost:11434/v1/embeddings');
  assert.equal(serviceEndpoints('https://example.com/compatible-mode/v1?tenant=x').embedding, 'https://example.com/compatible-mode/v1/embeddings?tenant=x');
  assert.equal(serviceEndpoints('https://example.com/v1/embeddings').models, 'https://example.com/v1/models');
  assert.deepEqual(serviceEndpoints('https://example.com/api/embed'), { embedding: 'https://example.com/api/embed', models: null, modelsFallback: null });
  for (const invalid of ['file:///secret', 'https://user:key@example.com/v1', 'https://example.com/v1#fragment']) assert.throws(() => serviceEndpoints(invalid));
});

test('Base URL HTTP requests use /embeddings for vectors and /models for discovery, sharing credentials', async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, method: req.method, key: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/models'
      ? { data: [{ id: 'chat-model' }, { id: 'qwen3.7-text-embedding-flash' }, { id: 'custom-vector', capabilities: ['TR'] }, { id: 'chat-model' }] }
      : { data: [{ index: 0, embedding: [1, 0] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const config = await tempConfig(t, { embeddingEndpoint: base });
  const client = new EmbeddingClient(config, { env: {}, apiKey: 'synthetic-key' });
  await client.embed(['fixed synthetic test']);
  const result = await discoverModels(client);
  assert.equal(result.models.length, 3); assert.equal(result.models.at(-1).id, 'chat-model');
  assert.ok(result.models[0].likelyEmbedding);
  assert.deepEqual(calls.map(c => [c.url, c.method, c.key]), [['/v1/embeddings', 'POST', 'Bearer synthetic-key'], ['/v1/models', 'GET', 'Bearer synthetic-key']]);
  assert.equal(calls[1].body, '');
  const complete = new EmbeddingClient({ ...config, embeddingEndpoint: `${base}/embeddings` });
  assert.equal(client.identity, complete.identity, 'Base/full spelling should reuse existing vectors');
});

test('Model discovery paginates OpenAI lists and retains aliases without embedding in the name', async t => {
  const config = await tempConfig(t);
  const urls = [];
  const client = new EmbeddingClient(config, { fetch: async url => {
    urls.push(url);
    return Response.json(url.includes('after=') ? { data: [{ id: 'my-private-vector-model' }], has_more: false }
      : { data: [{ id: 'embedding-first' }], has_more: true, last_id: 'embedding-first' });
  } });
  assert.equal((await discoverModels(client)).models.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get('after'), 'embedding-first');
});

test('Aliyun falls back to its same-origin model catalogue on an unsupported compatibility route, including pagination', async t => {
  const config = await tempConfig(t, { embeddingEndpoint: 'https://maas.qianwenaiapi.com/compatible-mode/v1' });
  const urls = [];
  const client = new EmbeddingClient(config, { apiKey: 'synthetic-key', fetch: async (url, options) => {
    urls.push(url); assert.equal(options.redirect, 'error');
    if (new URL(url).pathname.includes('compatible-mode')) return new Response('', { status: 404 });
    const page = Number(new URL(url).searchParams.get('page_no'));
    return Response.json({ output: { total: 2, models: [{ model: `alias-${page}`, capabilities: page === 2 ? ['TR'] : ['TG'] }] } });
  } });
  const result = await discoverModels(client);
  assert.equal(result.models.length, 2); assert.equal(result.models[0].id, 'alias-2');
  assert.equal(urls.length, 3); assert.ok(urls.every(url => new URL(url).origin === 'https://maas.qianwenaiapi.com'));
  assert.equal(result.endpoint, 'https://maas.qianwenaiapi.com/api/v1/models');
});

test('Discovery rejects auth, malformed responses and custom routes without unsafe fallback or secret disclosure', async t => {
  const config = await tempConfig(t, { embeddingEndpoint: 'https://maas.qianwenaiapi.com/compatible-mode/v1' });
  let requests = 0;
  const client = new EmbeddingClient(config, { fetch: async () => { requests++; return new Response('secret response', { status: 401 }); } });
  await assert.rejects(discoverModels(client), error => error.code === 'HTTP_401' && !error.message.includes('secret'));
  assert.equal(requests, 1);
  for (const data of [{}, { data: {} }, { output: { models: null } }]) {
    await assert.rejects(discoverModels(new EmbeddingClient(config, { fetch: async () => Response.json(data) })), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(discoverModels(new EmbeddingClient({ ...config, embeddingEndpoint: 'https://example.com/api/embed' }, { fetch: async () => { throw new Error('Must not request'); } })), { code: 'MODELS_UNSUPPORTED' });
});

test('Model discovery honours cancellation and a single deadline across the whole lookup', async t => {
  const config = await tempConfig(t);
  const client = new EmbeddingClient(config, { fetch: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const hold = setTimeout(() => {}, 500);
  try {
    await assert.rejects(discoverModels(client, { timeoutMs: 20 }), { code: 'ABORTED' });
    await assert.rejects(discoverModels(client, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
  } finally { clearTimeout(hold); }
});
