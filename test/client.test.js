import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const modules = process.env.HISTORY_RAG_TEST_UI_MODULES;

async function setup(t, override) {
  const require = createRequire(join(modules, '../package.json'));
  const { JSDOM } = require('jsdom');
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { Simulate } = require('react-dom/test-utils');
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const state = { embeddingEndpoint: 'https://example.com/v1/embeddings', embeddingModel: 'test-model', key: { configured: true, source: 'file' }, locks: {}, revision: 'rev-1' };
  let status = { configured: true, indexing: true, chunks: 80, embeddedChunks: 40, pending: 40, progress: { phase: 'indexing', total: 20, completed: 10 }, state: {} };
  const calls = [], dispose = [];
  let exports, component, props;
  dom.window.__ModuleLoader__ = { load(value) { exports = value.factory(name => { assert.equal(name, 'react'); return React; }); } };
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), dom.getInternalVMContext());
  const ctx = {
    effect(fn) { const off = fn(); if (off) dispose.push(off); },
    slots: { inject(name, fn) { assert.equal(name, 'settings.section'); fn(); }, register(options, view) { component = view; props = options.inject(); } },
    connection: { rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); const action = endpoint.split('/').at(-1); calls.push({ action, payload, signal });
      if (override) { const result = await override(action, payload); if (result) return result; }
      if (action === 'settings') return { ok: true, value: structuredClone(state) };
      if (action === 'status') return { ok: true, value: structuredClone(status) };
      if (action === 'save') { Object.assign(state, { embeddingEndpoint: payload.embeddingEndpoint, embeddingModel: payload.embeddingModel, revision: 'rev-2' }); return { ok: true, value: structuredClone(state) }; }
      return { ok: true, value: { dimensions: 1024, elapsedMs: 12 } };
    } } },
  };
  exports.apply(ctx);
  const root = createRoot(dom.window.document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(component, props)); await delay(10); });
  t.after(async () => { await React.act(() => root.unmount()); dispose.reverse().forEach(fn => fn()); dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.IS_REACT_ACT_ENVIRONMENT; });
  const input = async (id, value) => React.act(() => { const target = dom.window.document.getElementById(id); Simulate.change(target, { target: { value } }); });
  const button = text => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text);
  const click = async text => React.act(async () => { Simulate.click(button(text)); await delay(5); });
  return { dom, calls, input, button, click, root, React, setStatus: value => { status = value; } };
}

test('Settings UI mounts in the native slot, hides stored Keys and displays separate scan/vector progress', { skip: !modules }, async t => {
  const { dom } = await setup(t);
  const doc = dom.window.document;
  assert.equal(doc.getElementById('hr-key').type, 'password');
  assert.equal(doc.getElementById('hr-key').value, '');
  assert.equal(doc.getElementById('hr-model').value, 'test-model');
  assert.equal(doc.querySelector('[aria-label="历史扫描进度"]').value, 50);
  assert.equal(doc.querySelector('[aria-label="原文向量化进度"]').value, 50);
  assert.ok(doc.body.textContent.includes('10 / 20 个会话'));
});

test('Settings UI tests an unsaved draft and saves endpoint/model/Key, clearing the Key input after success', { skip: !modules }, async t => {
  const { dom, input, click, calls, React } = await setup(t);
  await input('hr-model', 'new-model'); await input('hr-key', 'draft-secret');
  await click('测试连接');
  assert.equal(calls.find(c => c.action === 'test').payload.apiKey, 'draft-secret');
  assert.ok(dom.window.document.body.textContent.includes('连接成功'));
  await React.act(async () => { dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await delay(10); });
  const saved = calls.find(c => c.action === 'save').payload;
  assert.equal(saved.embeddingModel, 'new-model'); assert.equal(saved.expectedRevision, 'rev-1');
  assert.equal(dom.window.document.getElementById('hr-key').value, '');
  assert.ok(dom.window.document.body.textContent.includes('已保存'));
});

test('Settings UI preserves a rejected draft, escapes server messages and cancels polling on unmount', { skip: !modules }, async t => {
  const { dom, input, React, calls, root } = await setup(t, action => action === 'save' ? { ok: false, error: { message: '设置已在其他窗口修改 <img src=x>' } } : null);
  await input('hr-model', 'unsaved-model');
  await React.act(async () => { dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await delay(10); });
  assert.equal(dom.window.document.getElementById('hr-model').value, 'unsaved-model');
  assert.equal(dom.window.document.querySelectorAll('img').length, 0);
  assert.ok(dom.window.document.querySelector('[role=alert]').textContent.includes('其他窗口'));
  await React.act(() => root.unmount());
  const count = calls.length; await delay(30); assert.equal(calls.length, count);
});

test('Settings UI refreshes progress automatically without overwriting unsaved form edits', { skip: !modules }, async t => {
  const { dom, input, React, setStatus } = await setup(t);
  await input('hr-model', 'my-unsaved-draft');
  setStatus({ configured: true, indexing: false, chunks: 80, embeddedChunks: 80, pending: 0, progress: { phase: 'complete', total: 20, completed: 20 }, state: {} });
  await React.act(async () => { await delay(2100); });
  assert.equal(dom.window.document.querySelector('[aria-label="原文向量化进度"]').value, 100);
  assert.equal(dom.window.document.getElementById('hr-model').value, 'my-unsaved-draft');
});

test('Model picker fetches an unsaved service without a model, supports selection and clears stale lists after service edits', { skip: !modules }, async t => {
  const { dom, input, click, calls, React } = await setup(t, action => action === 'models' ? { ok: true, value: { models: [
    { id: 'private-embedding', likelyEmbedding: true }, { id: 'custom-alias', likelyEmbedding: false },
  ], truncated: false } } : null);
  await input('hr-endpoint', 'https://draft.example/compatible-mode/v1');
  await input('hr-key', 'unsaved-key'); await input('hr-model', '');
  await click('获取模型列表');
  const payload = calls.find(c => c.action === 'models').payload;
  assert.equal(payload.apiKey, 'unsaved-key'); assert.equal(payload.embeddingModel, '');
  assert.equal(payload.embeddingEndpoint, 'https://draft.example/compatible-mode/v1');
  const select = dom.window.document.getElementById('hr-model-select');
  assert.equal(select.querySelectorAll('optgroup').length, 2);
  await React.act(() => { select.value = 'private-embedding'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  assert.equal(dom.window.document.getElementById('hr-model').value, 'private-embedding');
  assert.equal(dom.window.document.getElementById('hr-key').value, 'unsaved-key');
  assert.ok(!calls.some(c => c.action === 'save' || c.action === 'test'));
  await input('hr-endpoint', 'https://another.example/v1');
  assert.equal(dom.window.document.getElementById('hr-model-select'), null);
  await input('hr-model', 'manually-entered-model');
  assert.equal(dom.window.document.getElementById('hr-model').value, 'manually-entered-model');
});
