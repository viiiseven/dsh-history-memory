import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../index.js';
import { tempConfig, track, until } from './helpers.js';

const sdkRoot = process.env.HISTORY_RAG_TEST_SDK;

test('Installed DSH Connection: native settings routes are owner-only and persist redacted live settings', { skip: !sdkRoot }, async t => {
  const sdk = name => import(pathToFileURL(join(sdkRoot, '@deepseek-ai', name, 'lib', 'index.js')).href);
  const [{ Context }, { SessionStore }, { SessionQueryEngine }, { HostConnectionService }] = await Promise.all([
    sdk('cordis'), sdk('dsh-session'), sdk('dsh-session-query'), sdk('dsh-client-connection'),
  ]);
  const config = await tempConfig(t);
  const ctx = new Context();
  new SessionStore(ctx); new SessionQueryEngine(ctx);
  new HostConnectionService(ctx, [], { isAuthenticated: () => true });
  ctx.provide('agents', {});
  track(t, { close: () => ctx.fiber.dispose() });
  await ctx.plugin(plugin, { dataDir: config.dataDir }).await();
  const handler = ctx.connection.createSharedFetchHandler('/api');
  const request = (action, payload = {}) => new Request(`http://host/api/history-rag/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test-id', method: `history-rag/${action}`, payload }) });
  const peer = ctx.connection.browserPeer;
  let response;
  await until(async () => { response = await handler.fetch(request('settings'), peer); return response.status !== 404; });
  const settings = (await response.json()).result.value;
  assert.equal(settings.key.configured, false);
  const denied = await handler.fetch(request('settings'), { principal: { kind: 'guest' } });
  assert.equal(denied.status, 403);
  response = await handler.fetch(request('save', { embeddingEndpoint: 'http://127.0.0.1:9999/v1/embeddings', embeddingModel: 'saved-through-native-route', apiKey: 'native-test-secret', expectedRevision: settings.revision }), peer);
  const saved = await response.json();
  assert.equal(saved.result.ok, true); assert.equal(saved.result.value.key.configured, true);
  assert.ok(!JSON.stringify(saved).includes('native-test-secret'));
  const status = (await (await handler.fetch(request('status'), peer)).json()).result.value;
  assert.equal(status.model, 'saved-through-native-route');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options }); return Response.json({ data: [{ id: 'native-embedding-model' }] });
  });
  const modelList = await handler.fetch(request('models', { embeddingEndpoint: 'https://synthetic.example/v1', embeddingModel: '' }), peer);
  const found = (await modelList.json()).result;
  assert.equal(found.ok, true); assert.equal(found.value.models[0].id, 'native-embedding-model');
  assert.equal(calls[0].url, 'https://synthetic.example/v1/models');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer native-test-secret');
  assert.ok(!JSON.stringify(found).includes('native-test-secret'));
  assert.equal((await handler.fetch(request('models'), { principal: { kind: 'guest' } })).status, 403);
});
