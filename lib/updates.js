import { readFileSync } from 'node:fs';

export const UPDATE_REPOSITORY = 'viiiseven/dsh-history-memory';
export const UPDATE_URL = `https://github.com/${UPDATE_REPOSITORY}`;
const API = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
const RAW = `https://raw.githubusercontent.com/${UPDATE_REPOSITORY}/main/package.json`;
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SHA = /^[a-f0-9]{40}$/;

function buildInfo() {
  try {
    const value = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'));
    return { commit: SHA.test(value.commit) ? value.commit : null, dirty: value.dirty !== false };
  } catch { return { commit: null, dirty: false }; }
}

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!m || m.slice(1, 4).some(v => !Number.isSafeInteger(Number(v)))) return null;
  const pre = m[4]?.split('.') || [];
  if (pre.some(v => /^\d+$/.test(v) && v.length > 1 && v.startsWith('0'))) return null;
  return { numbers: m.slice(1, 4).map(Number), pre, text: value.replace(/^v/, '') };
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return Math.sign(x.numbers[i] - y.numbers[i]);
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !y.pre.length ? 0 : !x.pre.length ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const left = x.pre[i], right = y.pre[i];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    if (ln && rn) return left.length === right.length ? left > right ? 1 : -1 : left.length > right.length ? 1 : -1;
    return ln !== rn ? ln ? -1 : 1 : left > right ? 1 : -1;
  }
  return 0;
}

function error(code, retryAt = 0) { return Object.assign(new Error('更新检查未完成'), { code, retryAt }); }
function bounded(work, signal) {
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(error('TIMEOUT')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
  return Promise.race([work, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

export class UpdateChecker {
  constructor(runtime, { fetch = globalThis.fetch, version = manifest.version, build = buildInfo(), now = Date.now, startupDelayMs = 15000 } = {}) {
    this.runtime = runtime; this.fetch = fetch; this.version = version; this.build = build; this.now = now; this.startupDelayMs = startupDelayMs;
    this.closed = false; this.pending = null; this.timer = null; this.abort = null;
    this.lastCheckedAt = 0; this.nextCheckAt = 0; this.canCheckAt = 0; this.result = null; this.failure = null;
  }
  start(saved) {
    if (saved?.version === this.version && saved.commit === this.build.commit && saved.dirty === this.build.dirty
      && Number.isSafeInteger(saved.lastCheckedAt) && saved.lastCheckedAt > 0 && saved.lastCheckedAt <= this.now()
      && Number.isSafeInteger(saved.nextCheckAt) && saved.nextCheckAt <= this.now() + 7 * 86400000) {
      this.lastCheckedAt = saved.lastCheckedAt; this.nextCheckAt = saved.nextCheckAt;
      this.canCheckAt = saved.canCheckAt || 0; this.failure = saved.failure || null;
      // Only accept links in this repository, including cached results.
      if (saved.result && this.safeLink(saved.result.url)) this.result = saved.result;
    }
    this.schedule(Math.max(this.startupDelayMs, this.nextCheckAt - this.now()));
  }
  safeLink(url) { return typeof url === 'string' && (url === UPDATE_URL || url.startsWith(`${UPDATE_URL}/`)); }
  schedule(delay = Math.max(1000, this.nextCheckAt - this.now())) {
    clearTimeout(this.timer);
    if (this.closed || !this.runtime.config.updateCheckEnabled) return;
    this.timer = setTimeout(() => { this.check().finally(() => this.schedule()); }, delay);
    this.timer.unref();
  }
  status() {
    return { repository: UPDATE_URL, currentVersion: this.version, currentCommit: this.build.commit, localChanges: this.build.dirty,
      enabled: this.runtime.config.updateCheckEnabled, checking: Boolean(this.pending),
      lastCheckedAt: this.lastCheckedAt, nextCheckAt: this.nextCheckAt, canCheckAt: this.canCheckAt,
      result: this.result, error: this.failure };
  }
  async check({ manual = false } = {}) {
    if (this.closed) return this.status();
    if (this.pending) { await this.pending; return this.status(); }
    if ((!manual && (!this.runtime.config.updateCheckEnabled || this.now() < this.nextCheckAt)) || this.now() < this.canCheckAt) return this.status();
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.runtime.config.updateCheckTimeoutMs)]);
    this.pending = this.perform(signal).finally(() => { this.pending = null; this.abort = null; });
    await this.pending;
    return this.status();
  }
  async request(url, signal, { missing = false } = {}) {
    let response;
    try {
      response = await bounded(this.fetch(url, { method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `dsh-history-rag/${this.version}`, 'X-GitHub-Api-Version': '2022-11-28' } }), signal);
    } catch (e) { throw error(signal.aborted ? 'TIMEOUT' : e.code || 'NETWORK_ERROR'); }
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      const retry = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const retryAt = limited ? Math.min(this.now() + 86400000, Math.max(this.now() + 60000, Number.isFinite(reset) ? reset : 0, Number.isFinite(retry) ? this.now() + retry * 1000 : 0)) : 0;
      await response.body?.cancel(); throw error(limited ? 'RATE_LIMITED' : 'GITHUB_UNAVAILABLE', retryAt);
    }
    let text;
    try { text = await bounded(response.text(), signal); }
    catch { throw error(signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'); }
    if (text.length > 2 * 1024 * 1024) throw error('INVALID_RESPONSE');
    try { return JSON.parse(text); } catch { throw error('INVALID_RESPONSE'); }
  }
  packageVersion(value) {
    if (value?.encoding === 'base64' && typeof value.content === 'string') {
      try { value = JSON.parse(Buffer.from(value.content, 'base64').toString('utf8')); } catch { throw error('INVALID_RESPONSE'); }
    }
    if (value?.name !== manifest.name || !parseVersion(value?.version)) throw error('INVALID_RESPONSE');
    return value.version;
  }
  async inspect(signal) {
    let release;
    try { release = await this.request(`${API}/releases/latest`, signal, { missing: true }); }
    catch (e) {
      if (signal.aborted) throw e;
      return this.rawVersion(signal, e.code);
    }
    const published = release && !release.draft && !release.prerelease && parseVersion(release.tag_name);
    if (published && !published.pre.length && compareVersions(published.text, this.version) > 0) {
      return { available: true, kind: 'release', latestVersion: published.text, url: `${UPDATE_URL}/releases/tag/${encodeURIComponent(release.tag_name)}`, note: null };
    }
    let remote, version;
    try {
      remote = await this.request(`${API}/commits/main`, signal);
      if (!SHA.test(remote?.sha)) throw error('INVALID_RESPONSE');
      version = this.packageVersion(await this.request(`${API}/contents/package.json?ref=${remote.sha}`, signal));
    } catch (e) { if (signal.aborted) throw e; return this.rawVersion(signal, e.code); }
    const compared = compareVersions(version, this.version);
    const base = { latestVersion: version, latestCommit: remote.sha, url: `${UPDATE_URL}/tree/${remote.sha}`, note: null };
    if (compared !== 0) return { ...base, available: compared > 0, kind: compared > 0 ? 'version' : 'local-newer' };
    if (remote.sha === this.build.commit) return { ...base, available: false, kind: 'current' };
    if (!this.build.commit || this.build.dirty) return { ...base, available: false, kind: 'version-only', note: this.build.dirty ? 'LOCAL_CHANGES' : 'NO_BUILD_COMMIT' };
    let comparison;
    try { comparison = await this.request(`${API}/compare/${this.build.commit}...${remote.sha}`, signal, { missing: true }); }
    catch (e) { return { ...base, available: false, kind: 'version-only', note: e.code }; }
    if (!comparison) return { ...base, available: false, kind: 'version-only', note: 'UNKNOWN_BUILD_COMMIT' };
    if (!['ahead', 'behind', 'identical', 'diverged'].includes(comparison.status)) throw error('INVALID_RESPONSE');
    return { ...base, available: comparison.status === 'ahead',
      kind: comparison.status === 'ahead' ? 'commit' : comparison.status === 'behind' ? 'local-newer' : comparison.status === 'diverged' ? 'diverged' : 'current',
      url: `${UPDATE_URL}/compare/${this.build.commit}...${remote.sha}` };
  }
  async rawVersion(signal, note) {
    const version = this.packageVersion(await this.request(RAW, signal));
    const compared = compareVersions(version, this.version);
    return { available: compared > 0, kind: compared > 0 ? 'version' : compared < 0 ? 'local-newer' : 'version-only',
      latestVersion: version, url: `${UPDATE_URL}/tree/main`, note: note || 'VERSION_ONLY' };
  }
  async perform(signal) {
    this.lastCheckedAt = this.now(); this.canCheckAt = this.now() + 60000;
    try {
      const result = await this.inspect(signal);
      if (this.closed) return;
      this.result = result; this.failure = null;
      this.nextCheckAt = this.now() + this.runtime.config.updateCheckIntervalMs;
    } catch (e) {
      if (this.closed) return;
      this.failure = { code: signal.aborted ? 'TIMEOUT' : ['RATE_LIMITED', 'INVALID_RESPONSE', 'NETWORK_ERROR'].includes(e.code) ? e.code : 'GITHUB_UNAVAILABLE' };
      this.nextCheckAt = Math.max(this.now() + 3600000, e.retryAt || 0);
      this.canCheckAt = Math.max(this.canCheckAt, e.retryAt || 0);
    }
    if (!this.closed) {
      try { await this.runtime.db.call('setState', 'updateCheck', { version: this.version, commit: this.build.commit, dirty: this.build.dirty,
        lastCheckedAt: this.lastCheckedAt, nextCheckAt: this.nextCheckAt, canCheckAt: this.canCheckAt, result: this.result, failure: this.failure }); }
      catch { /* A cache write failure must not interrupt chat or discard a useful check. */ }
    }
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.abort?.abort(); await this.pending; }
}
