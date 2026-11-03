import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULTS } from '../lib/config.js';
import { UpdateChecker, compareVersions, parseVersion, UPDATE_URL } from '../lib/updates.js';
import { until } from './helpers.js';

const local = 'a'.repeat(40), remote = 'b'.repeat(40);
function setup(t, respond, options = {}) {
  const requests = [], persisted = [];
  const runtime = { config: { ...DEFAULTS }, db: { async call(method, key, value) { assert.equal(method, 'setState'); assert.equal(key, 'updateCheck'); persisted.push(structuredClone(value)); } } };
  const checker = new UpdateChecker(runtime, { version: '0.6.0', build: { commit: local, dirty: false },
    fetch: async (url, options) => { requests.push({ url, options }); return respond(url, options); }, ...options });
  t.after(() => checker.close());
  return { checker, requests, persisted, runtime };
}
const packageFile = version => Response.json({ name: 'dsh-history-rag', version });
function branch(version = '0.6.0', status = 'ahead') {
  return url => url.endsWith('/releases/latest') ? new Response('', { status: 404 })
    : url.endsWith('/commits/main') ? Response.json({ sha: remote })
    : url.includes('/contents/') ? Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify({ name: 'dsh-history-rag', version })).toString('base64') })
    : Response.json({ status });
}

test('Version ordering handles numeric components, prereleases and metadata without lexical mistakes', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0-beta.10'), 1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.3'), 0);
  for (const value of ['1.2', '01.2.3', '1.0.0-01', '1.0.0+foo..bar', 'javascript:1.0.0']) assert.equal(parseVersion(value), null);
});

test('A newer stable release is reported without downloading assets, transmitting keys or using supplied external links', async t => {
  const { checker, requests } = setup(t, () => Response.json({ tag_name: 'v0.7.0', draft: false, prerelease: false,
    html_url: 'https://untrusted.example/update', assets: [{ browser_download_url: 'https://untrusted.example/file' }] }));
  const state = await checker.check({ manual: true });
  assert.equal(state.result.kind, 'release'); assert.equal(state.result.available, true);
  assert.equal(state.result.url, `${UPDATE_URL}/releases/tag/v0.7.0`);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined); assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.redirect, 'error');
});

test('No release is required: main package version is checked and local newer versions are not called updates', async t => {
  const newer = setup(t, branch('0.7.0')); assert.equal((await newer.checker.check({ manual: true })).result.kind, 'version');
  const older = setup(t, branch('0.5.0')); const state = await older.checker.check({ manual: true });
  assert.equal(state.result.kind, 'local-newer'); assert.equal(state.result.available, false);
});

test('Same-version commits are compared by ancestry; old, unknown and divergent revisions do not give false updates', async t => {
  for (const [status, kind, available] of [['ahead', 'commit', true], ['behind', 'local-newer', false], ['identical', 'current', false], ['diverged', 'diverged', false]]) {
    const { checker } = setup(t, branch('0.6.0', status)); const result = (await checker.check({ manual: true })).result;
    assert.equal(result.kind, kind); assert.equal(result.available, available);
  }
  const respond = branch();
  const { checker } = setup(t, url => url.includes('/compare/') ? new Response('', { status: 404 }) : respond(url));
  const result = (await checker.check({ manual: true })).result;
  assert.equal(result.kind, 'version-only'); assert.equal(result.note, 'UNKNOWN_BUILD_COMMIT'); assert.equal(result.available, false);
});

test('Unpublished local modifications are disclosed and only version numbers are compared', async t => {
  const { checker, requests } = setup(t, branch(), { build: { commit: local, dirty: true } });
  const result = (await checker.check({ manual: true })).result;
  assert.equal(result.kind, 'version-only'); assert.equal(result.note, 'LOCAL_CHANGES');
  assert.ok(!requests.some(r => r.url.includes('/compare/')));
});

test('API rate limits fall back to the public package file and explicitly disclose version-only checking', async t => {
  const { checker, requests } = setup(t, url => url.startsWith('https://raw.githubusercontent.com/') ? packageFile('0.6.0')
    : new Response('provider response must not be shown', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
  const state = await checker.check({ manual: true });
  assert.equal(state.error, null); assert.equal(state.result.note, 'RATE_LIMITED'); assert.equal(state.result.kind, 'version-only');
  assert.equal(requests.length, 2); assert.ok(!JSON.stringify(state).includes('provider response'));
});

test('Single-flight checks, a one-minute manual cooldown and persistent cache prevent repeated network traffic', async t => {
  let release;
  const { checker, persisted, requests, runtime } = setup(t, () => new Promise(resolve => { release = resolve; }));
  const a = checker.check({ manual: true }), b = checker.check({ manual: true });
  release(Response.json({ tag_name: 'v0.7.0' })); await Promise.all([a, b]);
  await checker.check({ manual: true }); assert.equal(requests.length, 1); assert.equal(persisted.length, 1);
  const restored = new UpdateChecker(runtime, { version: '0.6.0', build: { commit: local, dirty: false }, fetch: async () => { throw new Error('Cache should avoid network'); }, startupDelayMs: 5 });
  t.after(() => restored.close()); restored.start(persisted[0]);
  await delay(15); assert.equal(restored.status().result.kind, 'release'); assert.equal(restored.status().error, null);
});

test('Malformed metadata and network failure preserve the last good result and schedule retries', async t => {
  let time = Date.now(), fail = false;
  const { checker } = setup(t, () => fail ? Response.json({ name: 'unexpected-package', version: 'bad' }) : Response.json({ tag_name: 'v0.7.0' }), { now: () => time });
  await checker.check({ manual: true }); fail = true; time += 61000;
  const state = await checker.check({ manual: true });
  assert.equal(state.result.latestVersion, '0.7.0'); assert.equal(state.error.code, 'INVALID_RESPONSE'); assert.ok(state.nextCheckAt > time);
});

test('Automatic startup checks run without opening settings; disabled mode and unload stop background work', async t => {
  const { checker, requests } = setup(t, () => Response.json({ tag_name: 'v0.7.0' }), { startupDelayMs: 5 });
  checker.start(); await until(() => requests.length === 1 && !checker.pending);
  await checker.close(); await delay(10); assert.equal(requests.length, 1);
  const disabled = setup(t, () => { throw new Error('Disabled automatic check must not run'); }, { startupDelayMs: 5 });
  disabled.runtime.config.updateCheckEnabled = false; disabled.checker.start(); await delay(15); assert.equal(disabled.requests.length, 0);
});

test('Timeout and unload bound a fetch implementation that ignores abort signals', async t => {
  const timed = setup(t, () => new Promise(() => {})); timed.runtime.config.updateCheckTimeoutMs = 30;
  const hold = setTimeout(() => {}, 500);
  try { assert.equal((await timed.checker.check({ manual: true })).error.code, 'TIMEOUT'); }
  finally { clearTimeout(hold); }
  const unloaded = setup(t, () => new Promise(() => {})); const pending = unloaded.checker.check({ manual: true });
  await unloaded.checker.close(); await pending; assert.equal(unloaded.persisted.length, 0);
});
