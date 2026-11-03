import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { tempConfig } from './helpers.js';

test('Configuration precedence is defaults < file < plugin row < environment for endpoint/model', async t => {
  const initial = await tempConfig(t);
  await writeFile(join(initial.dataDir, 'config.json'), JSON.stringify({ topK: 2, embeddingModel: 'file', embeddingEndpoint: 'https://file.invalid/embeddings' }));
  const config = resolveConfig({ dataDir: initial.dataDir, topK: 3 }, { HISTORY_RAG_MODEL: 'environment' });
  assert.equal(config.topK, 3); assert.equal(config.embeddingModel, 'environment');
  assert.equal(config.embeddingEndpoint, 'https://file.invalid/embeddings');
});

test('Invalid slicing, scopes and URL credentials are rejected early', async t => {
  const config = await tempConfig(t);
  for (const invalid of [{ chunkOverlap: 800 }, { topK: 0 }, { scope: 'guess' }, { minScore: 7 }, { embeddingEndpoint: 'https://user:secret@example.invalid/api' }]) {
    assert.throws(() => resolveConfig({ dataDir: config.dataDir, ...invalid }, {}));
  }
});
