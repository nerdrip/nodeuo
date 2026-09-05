import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildAnimationShards,
  validateAnimationManifest,
  validateAnimationShardIndex,
} from '../anim.js';
import { publishMobileKtx2Index } from '../mobile-atlas-ktx2.js';

function body(page, x) {
  return { actions: { 0: { dirs: { 0: [{ page, u: x, v: 1, w: 8, h: 9, cx: 4, cy: 8 }] } } } };
}

test('mobile atlas shards retain every imported UO body with immutable integrity metadata', () => {
  const manifest = {
    schemaVersion: 4, pageCount: 2, atlasW: 64, atlasH: 64,
    actions: [0], uopActions: [0], directions: 5,
    aliases: { 5: { trueBody: 70, hue: 0 } },
    bodyConv: {}, equipConv: {}, corpseConv: {}, mobTypes: {},
    bodies: { 5: body(0, 1), 63: body(0, 10), 64: body(1, 1), 70: body(1, 10) },
  };
  validateAnimationManifest(manifest);
  const pages = {
    0: { file: 'mobiles-atlas-page-000-0123456789abcdef.png', sha256: '0'.repeat(64), bytes: 10 },
    1: { file: 'mobiles-atlas-page-001-fedcba9876543210.png', sha256: 'f'.repeat(64), bytes: 20 },
  };
  const first = buildAnimationShards(manifest, 64, pages);
  const second = buildAnimationShards(manifest, 64, pages);
  assert.equal(first.index.revision, second.index.revision, 'same UO input must produce a stable revision');
  assert.deepEqual(validateAnimationShardIndex(first.index, first.payloads), { shards: 2, bodies: 4 });
  assert.deepEqual(first.index.shards[0].bodyIds, [5, 63]);
  assert.deepEqual(first.index.shards[1].bodyIds, [64, 70]);
  assert.deepEqual(first.index.pages, pages);
  const reconstructed = {};
  for (const payload of first.payloads.values()) Object.assign(reconstructed, JSON.parse(payload).bodies);
  assert.deepEqual(reconstructed, manifest.bodies);

  const [file, payload] = first.payloads.entries().next().value;
  const corrupted = new Map(first.payloads);
  corrupted.set(file, `${payload} `);
  assert.throws(() => validateAnimationShardIndex(first.index, corrupted), /integrity mismatch/);
});

test('KTX2 post-processing atomically extends the importer index', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'nodeuo-mobile-atlas-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const index = {
    schemaVersion: 4, format: 'nodeuo.mobile-atlas-shards', pageCount: 1,
    pages: { 0: { file: 'mobiles-atlas-page-000-0123456789abcdef.png', sha256: '0'.repeat(64), bytes: 10 } },
    shards: {}, revision: 'old',
  };
  const compressed = Buffer.from('synthetic-ktx2-page');
  await writeFile(join(directory, 'mobiles-atlas-index.json'), JSON.stringify(index));
  await writeFile(join(directory, 'mobiles-atlas-00.ktx2'), compressed);
  const result = await publishMobileKtx2Index(directory);
  const actual = JSON.parse(await readFile(join(directory, 'mobiles-atlas-index.json'), 'utf8'));
  const digest = createHash('sha256').update(compressed).digest('hex');
  assert.equal(result.published, 1);
  assert.deepEqual(actual.pages[0].ktx2, {
    file: `mobiles-atlas-page-000-${digest.slice(0, 16)}.ktx2`, sha256: digest, bytes: compressed.length,
  });
  assert.deepEqual(await readFile(join(directory, actual.pages[0].ktx2.file)), compressed);
  const revision = actual.revision;
  delete actual.revision;
  assert.equal(revision, createHash('sha256').update(JSON.stringify(actual)).digest('hex'));
});
