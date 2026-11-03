import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddingClient } from '../lib/embedding.js';
import { tempConfig } from './helpers.js';

async function server(t, handle) {
  const instance = createServer(handle);
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${instance.address().port}/v1/embeddings`;
}

test('HTTP protocol: prefixes, auth, batch reordering, dimensions and unit normalization', async t => {
  let received;
  const endpoint = await server(t, async (req, res) => {
    let body = ''; for await (const data of req) body += data;
    received = { body: JSON.parse(body), headers: req.headers };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 5] }, { index: 0, embedding: [3, 0] }] }));
  });
  const config = await tempConfig(t, { embeddingEndpoint: endpoint, queryPrefix: 'query: ', documentPrefix: 'passage: ', dimensions: 2 });
  const client = new EmbeddingClient(config, { env: { HISTORY_RAG_API_KEY: 'test-secret' } });
  const vectors = await client.embed(['A', 'B']);
  assert.deepEqual(vectors.map(v => [...v]), [[1, 0], [0, 1]]);
  assert.deepEqual(received.body, { model: 'test', input: ['passage: A', 'passage: B'], encoding_format: 'float', dimensions: 2 });
  assert.equal(received.headers.authorization, 'Bearer test-secret');
});

test('Invalid response, missing vectors and dimension changes are rejected', async t => {
  const config = await tempConfig(t, { dimensions: 2 });
  for (const data of [
    { data: [] }, { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: [1, 2, 3] }] }, { data: [{ index: 4, embedding: [1, 0] }] },
  ]) {
    const client = new EmbeddingClient(config, { fetch: async () => new Response(JSON.stringify(data)) });
    await assert.rejects(client.embed(['x']));
  }
});

test('HTTP errors do not leak response bodies, keys, or conversation text', async t => {
  const config = await tempConfig(t);
  const client = new EmbeddingClient(config, { fetch: async () => new Response('secret-key private text', { status: 401 }) });
  await assert.rejects(client.embed(['private text']), error => error.code === 'HTTP_401' && !/secret|private/.test(error.message));
});

test('Embedding timeout aborts a stalled HTTP request', async t => {
  const endpoint = await server(t, () => {});
  const config = await tempConfig(t, { embeddingEndpoint: endpoint, embeddingTimeoutMs: 100 });
  await assert.rejects(new EmbeddingClient(config).embed(['x']), { code: 'ABORTED' });
});

test('Model identity changes for model, URL or instruction; API key rotation preserves it', async t => {
  const config = await tempConfig(t);
  const initial = new EmbeddingClient(config);
  for (const changes of [{ embeddingModel: 'another' }, { dimensions: 7 }, { queryPrefix: 'query:' }, { embeddingEndpoint: 'https://example.invalid/v1/embeddings' }]) {
    assert.notEqual(initial.identity, new EmbeddingClient({ ...config, ...changes }).identity);
  }
  assert.equal(initial.identity, new EmbeddingClient(config, { env: { HISTORY_RAG_API_KEY: 'rotated' } }).identity);
});

test('Desktop can read a local key file; rotation is picked up without storing the key in the index', async t => {
  const config = await tempConfig(t, { apiKeyFile: 'embedding.key' });
  const headers = [];
  const client = new EmbeddingClient(config, { env: {}, fetch: async (_url, options) => {
    headers.push(options.headers.Authorization);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  } });
  await writeFile(join(config.dataDir, 'embedding.key'), 'first-key\n');
  await client.embed(['x']);
  await writeFile(join(config.dataDir, 'embedding.key'), 'second-key');
  await client.embed(['x']);
  assert.deepEqual(headers, ['Bearer first-key', 'Bearer second-key']);
});
