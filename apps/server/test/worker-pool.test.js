import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerTaskPool } from '../src/systems/worker-pool.js';

const cleanup = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('WorkerTaskPool', () => {
  it('reuses a bounded worker and exposes queue diagnostics', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-worker-'));
    cleanup.push(directory);
    const file = path.join(directory, 'asset.json');
    fs.writeFileSync(file, JSON.stringify({ entries: [{ id: 1 }, { id: 2 }] }));
    const pool = new WorkerTaskPool(new URL('../src/admin/asset-worker.js', import.meta.url), {
      size: 1, maxQueue: 4, name: 'test-assets',
    });
    try {
      const first = await pool.run({ action: 'summary', file, collectionPath: ['entries'] });
      const second = await pool.run({ action: 'entry', file, collectionPath: ['entries'], id: 1 });
      expect(first.count).toBe(2);
      expect(second.value).toEqual({ id: 2 });
      expect(pool.snapshot()).toMatchObject({ workers: 1, submitted: 2, completed: 2, queued: 0 });
    } finally { await pool.close(); }
  });

  it('streams mobile-atlas integrity progress and reuses trusted fingerprints', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-atlas-worker-'));
    cleanup.push(directory);
    const bytes = Buffer.from('small immutable atlas fixture');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(directory, 'page.bin'), bytes);
    fs.writeFileSync(path.join(directory, 'mobiles-atlas-index.json'), JSON.stringify({
      format: 'nodeuo.mobile-atlas-shards', revision: 'test',
      pages: { 0: { file: 'page.bin', bytes: bytes.length, sha256 } }, shards: {},
    }));
    const pool = new WorkerTaskPool(new URL('../src/admin/asset-worker.js', import.meta.url), { size: 1 });
    try {
      const progress = [];
      const first = await pool.run({ action: 'mobile-integrity', root: directory }, { onProgress: (row) => progress.push(row) });
      expect(first).toMatchObject({ files: 1, size: bytes.length, cached: 0, revision: 'test' });
      expect(progress).toEqual([expect.objectContaining({ completed: 1, total: 1, file: 'page.bin' })]);
      const second = await pool.run({ action: 'mobile-integrity', root: directory, cache: first.fingerprints });
      expect(second.cached).toBe(1);
    } finally { await pool.close(); }
  });
});
