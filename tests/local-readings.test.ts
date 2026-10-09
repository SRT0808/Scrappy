import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { localReadings } from '../scripts/local-readings.js';

const id = '11111111-1111-4111-8111-111111111111';

test('local executor passes only the reading ID, inherits server configuration and deduplicates children', async () => {
  const root = await mkdtemp(resolve('.scrappy/local-reading-test-'));
  assert.ok(root.startsWith(resolve('.scrappy') + sep));
  const executor = localReadings(root);
  try {
    await symlink(resolve('.venv'), resolve(root, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
    await mkdir(resolve(root, 'scraper/src/scrappy'), { recursive: true });
    await writeFile(resolve(root, 'scraper/src/scrappy/__init__.py'), '');
    await writeFile(resolve(root, 'scraper/src/scrappy/run.py'), `import json, os, sys, time
from pathlib import Path
with Path('calls.jsonl').open('a') as output:
    output.write(json.dumps({'args': sys.argv[1:], 'configured': bool(os.environ.get('SCRAPPY_LOCAL_TEST'))}) + '\\n')
time.sleep(2)
`);
    process.env.SCRAPPY_LOCAL_TEST = 'server-configuration';
    await executor.dispatch(id);
    await executor.dispatch(id);
    let content = '';
    for (let attempt = 0; attempt < 100; attempt++) {
      try { content = await readFile(resolve(root, 'calls.jsonl'), 'utf8'); } catch { /* Wait for the child. */ }
      if (content) break;
      await setTimeout(20);
    }
    assert.deepEqual(content.trim().split('\n').map(line => JSON.parse(line)), [
      { args: ['--mode', 'reading', '--reading-id', id], configured: true },
    ]);
    await executor.dispatchProduct(id);
    await executor.dispatchProduct(id);
    for (let attempt = 0; attempt < 100; attempt++) {
      content = await readFile(resolve(root, 'calls.jsonl'), 'utf8');
      if (content.trim().split('\n').length === 2) break;
      await setTimeout(20);
    }
    assert.deepEqual(content.trim().split('\n').map(line => JSON.parse(line))[1],
      { args: ['--mode', 'product', '--product-id', id], configured: true });
    await assert.rejects(executor.dispatch('invalid; command'), /Invalid reading ID/);
  } finally {
    executor.close();
    delete process.env.SCRAPPY_LOCAL_TEST;
    // The child may still hold the working directory briefly on Windows.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('missing local Python rejects dispatch without an unhandled process error', async () => {
  const root = await mkdtemp(resolve('.scrappy/local-reading-missing-'));
  assert.ok(root.startsWith(resolve('.scrappy') + sep));
  const executor = localReadings(root);
  try {
    await assert.rejects(executor.dispatch(id), /Local Python unavailable/);
  } finally {
    executor.close();
    await rm(root, { recursive: true, force: true });
  }
});
