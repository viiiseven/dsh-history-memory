import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function check(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.test-data'].includes(item.name)) continue;
    const path = `${dir}/${item.name}`;
    if (item.isDirectory()) await check(path);
    else if (/\.(js|mjs)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) { console.error(result.stderr); process.exitCode = 1; }
    }
  }
}
await check(root);
if (!process.exitCode) console.log('JavaScript syntax checks passed.');
