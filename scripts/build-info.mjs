import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let commit = null, dirty = true;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim());
} catch { /* Source archive builds still support version checking without Git metadata. */ }
await writeFile(new URL('../build-info.json', import.meta.url), `${JSON.stringify({ commit, dirty }, null, 2)}\n`);
console.log(`Build identity: ${commit?.slice(0, 7) || 'version only'}${dirty ? ' (local changes)' : ''}`);
