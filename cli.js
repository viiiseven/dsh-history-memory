#!/usr/bin/env node
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig } from './lib/config.js';
import { Database } from './lib/database.js';
import { EmbeddingClient } from './lib/embedding.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';
const flag = args.indexOf('--config');
const input = flag >= 0 ? { configFile: args[flag + 1] } : {};
if (flag >= 0) args.splice(flag, 2);
try {
  const config = resolveConfig(input);
  if (command === 'init') {
    await mkdir(config.dataDir, { recursive: true });
    await copyFile(new URL('./config.example.json', import.meta.url), config.configFile, 1);
    console.log(`已创建配置：${config.configFile}`);
  } else if (command === 'status') {
    const db = new Database(join(config.dataDir, 'history.sqlite'));
    try {
      const client = new EmbeddingClient(config);
      console.log(JSON.stringify({ configured: client.configured, model: config.embeddingModel || null, database: join(config.dataDir, 'history.sqlite'), ...await db.call('status', client.identity) }, null, 2));
    } finally { await db.close(); }
  } else if (command === 'reindex') {
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(join(config.dataDir, 'rebuild.request'), args.includes('--vectors') ? 'vectors' : 'sources', { mode: 0o600 });
    console.log('已提交重建请求；运行中的 DSH 插件将在下一轮扫描处理。');
  } else if (command === 'search') {
    const query = args.slice(1).join(' ').trim();
    if (!query) throw new Error('用法：dsh-history-rag search 要搜索的内容');
    const client = new EmbeddingClient(config);
    const [vector] = await client.embed([query], { query: true });
    const db = new Database(join(config.dataDir, 'history.sqlite'));
    try {
      const hits = await db.search(client.identity, vector, { topK: config.topK, minScore: config.minScore,
        scope: config.scope, cwd: process.cwd(), excludeSessionIds: config.excludeSessionIds, excludeWorkspaces: config.excludeWorkspaces });
      console.log(JSON.stringify(hits, null, 2));
    } finally { await db.close(); }
  } else {
    console.log('dsh-history-rag init | status | search <问题> | reindex [--vectors]\n可附加 --config <配置文件路径>。');
    if (command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? '配置已存在，未覆盖。' : error.message);
  process.exitCode = 1;
}
