import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from '../lib/config.js';

export async function tempConfig(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-history-rag-test-'));
  t.resources ||= [];
  t.after(async () => {
    for (const resource of [...t.resources].reverse()) await resource.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return resolveConfig({ dataDir, embeddingEndpoint: 'http://127.0.0.1:9999/v1/embeddings', embeddingModel: 'test', ...overrides }, {});
}
export function track(t, resource) { (t.resources ||= []).push(resource); return resource; }
export function message(text, kind = 'user') {
  return { id: randomUUID(), role: 'user', source: { kind }, content: [{ type: 'text', text }] };
}
export function snapshot(id, texts, cwd = 'C:/project') {
  return { session: { id, cwd, createdAt: 1 }, events: texts.map((text, seq) => ({
    type: seq % 2 ? 'assistant/message' : 'user/message', seq, time: seq + 1,
    data: seq % 2 ? { turn: 1, step: 1, message: { ...message(text, 'model'), role: 'assistant' } } : message(text),
  })) };
}
export async function until(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(20); }
  throw new Error('Condition did not become true');
}
export function fakeClient() {
  return { configured: true, identity: 'fake-2d', calls: [], async embed(texts, options) {
    this.calls.push({ texts, query: Boolean(options?.query) });
    return texts.map(text => Float32Array.from(/鲸|部署|旧话/.test(text) ? [1, 0] : [0, 1]));
  } };
}
