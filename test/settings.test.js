import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SettingsController, registerSettings } from '../lib/settings.js';
import { resolveConfig } from '../lib/config.js';
import { EmbeddingClient } from '../lib/embedding.js';
import { tempConfig } from './helpers.js';

async function setup(t, dependencies = {}) {
  const config = await tempConfig(t);
  const runtime = { config, closed: false, reconfigure(value) { this.config = value; },
    async status() { return { chunks: 12, embeddedChunks: 5 }; }, async scan() {} };
  const controller = new SettingsController(runtime, {}, { env: {}, ...dependencies });
  return { controller, runtime, config };
}

test('Settings save persists endpoint/model and Key, applies live, and never returns the secret', async t => {
  const { controller, runtime, config } = await setup(t);
  const before = await controller.read();
  const saved = await controller.save({ embeddingEndpoint: 'https://embedding.example/v1/embeddings', embeddingModel: 'new-model', apiKey: 'unique-secret-key', expectedRevision: before.revision });
  assert.equal(saved.embeddingModel, 'new-model'); assert.equal(saved.key.configured, true);
  assert.ok(!JSON.stringify(saved).includes('unique-secret-key'));
  const doc = await readFile(config.configFile, 'utf8');
  assert.ok(!doc.includes('unique-secret-key'));
  assert.equal(runtime.config.embeddingModel, 'new-model');
  assert.equal(resolveConfig({ dataDir: config.dataDir }, {}).embeddingModel, 'new-model');
  assert.equal(await readFile(join(config.dataDir, runtime.config.apiKeyFile), 'utf8'), 'unique-secret-key');
});

test('Blank Key preserves the saved credential; explicit clear removes only plugin-managed credentials', async t => {
  const { controller, runtime, config } = await setup(t);
  let saved = await controller.save({ apiKey: 'first-key', expectedRevision: (await controller.read()).revision });
  const keyFile = runtime.config.apiKeyFile;
  saved = await controller.save({ apiKey: '', embeddingModel: 'changed', expectedRevision: saved.revision });
  assert.equal(runtime.config.apiKeyFile, keyFile);
  assert.equal(await readFile(join(config.dataDir, keyFile), 'utf8'), 'first-key');
  await controller.save({ clearApiKey: true, expectedRevision: saved.revision });
  assert.equal((await controller.read()).key.configured, false);
  await assert.rejects(readFile(join(config.dataDir, keyFile)), { code: 'ENOENT' });
});

test('Concurrent stale settings writers are refused without replacing the accepted Key', async t => {
  const { controller, runtime, config } = await setup(t);
  const revision = (await controller.read()).revision;
  const results = await Promise.allSettled([
    controller.save({ embeddingModel: 'accepted', apiKey: 'accepted-key', expectedRevision: revision }),
    controller.save({ embeddingModel: 'stale', apiKey: 'stale-key', expectedRevision: revision }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'SETTINGS_CONFLICT');
  assert.equal(runtime.config.embeddingModel, 'accepted');
  assert.equal(await readFile(join(config.dataDir, runtime.config.apiKeyFile), 'utf8'), 'accepted-key');
});

test('A failed configuration write preserves accepted settings and cleans staged Key files', async t => {
  const { controller, runtime, config } = await setup(t, { persist: async () => { throw new Error('synthetic failure'); } });
  const previous = runtime.config;
  await assert.rejects(controller.save({ apiKey: 'unsaved-key', embeddingModel: 'unsaved', expectedRevision: (await controller.read()).revision }), { code: 'SAVE_FAILED' });
  assert.equal(runtime.config, previous);
  assert.equal((await readdir(config.dataDir)).filter(f => f.startsWith('embedding-ui-')).length, 0);
});

test('Environment-owned controls are locked and credentials are redacted', async t => {
  const { runtime } = await setup(t);
  const controller = new SettingsController(runtime, {}, { env: { HISTORY_RAG_API_KEY: 'environment-secret', HISTORY_RAG_MODEL: 'managed' } });
  const view = await controller.read();
  assert.equal(view.locks.apiKey, true); assert.equal(view.locks.embeddingModel, true);
  assert.ok(!JSON.stringify(view).includes('environment-secret'));
  await assert.rejects(controller.save({ apiKey: 'other', expectedRevision: view.revision }), { code: 'SETTING_LOCKED' });
});

test('Connection test sends fixed text, returns dimensions, and does not save the draft', async t => {
  let texts;
  const { controller, config } = await setup(t, { clientFactory: () => ({ async embed(input) { texts = input; return [new Float32Array([1, 0])]; } }) });
  const before = await controller.read();
  const result = await controller.test({ embeddingModel: 'draft-model' });
  assert.equal(result.dimensions, 2); assert.deepEqual(texts, ['Embedding 连接测试']);
  assert.equal((await controller.read()).revision, before.revision);
  await assert.rejects(readFile(config.configFile), { code: 'ENOENT' });
});

test('Malformed input and RPC failures do not return secrets or arbitrary exception messages', async t => {
  const { controller } = await setup(t);
  await assert.rejects(controller.save({ apiKey: 'secret', dataDir: 'unsafe' }), { code: 'BAD_INPUT' });
  const routes = [];
  registerSettings({ connection: { fetch: { register: route => routes.push(route) } } }, controller);
  const route = routes.find(r => r.path.endsWith('/save'));
  const response = await route.fetch(new Request('http://host/api/history-rag/save', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'history-rag/save', payload: { embeddingEndpoint: 'file:///secret', apiKey: 'secret-key' } }) }));
  const text = await response.text();
  assert.ok(!text.includes('secret-key')); assert.equal(JSON.parse(text).result.ok, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Model list uses an unsaved URL/Key with no model selected, without saving or embedding history', async t => {
  const requests = [];
  const { controller, config, runtime } = await setup(t, { clientFactory: (config, options) => new EmbeddingClient(config, { env: {}, ...options,
    fetch: async (url, options) => { requests.push({ url, options }); return Response.json({ data: [{ id: 'private-embedding' }] }); } }) });
  const before = await controller.read();
  const result = await controller.models({ embeddingEndpoint: 'https://draft.example/v1', embeddingModel: '', apiKey: 'draft-only-key' });
  assert.equal(result.models[0].id, 'private-embedding');
  assert.equal(requests[0].url, 'https://draft.example/v1/models');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer draft-only-key');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(runtime.config.embeddingModel, 'test');
  assert.equal((await controller.read()).revision, before.revision);
  assert.ok(!JSON.stringify(result).includes('draft-only-key'));
  await assert.rejects(readFile(config.configFile), { code: 'ENOENT' });
});

test('Unavailable model discovery gives a manual-entry path and never echoes provider errors', async t => {
  const { controller } = await setup(t, { clientFactory: config => new EmbeddingClient(config, { fetch: async () => new Response('provider-secret', { status: 404 }) }) });
  await assert.rejects(controller.models({}), error => error.code === 'MODELS_FAILED' && error.message.includes('手动填写') && !error.message.includes('provider-secret'));
});
