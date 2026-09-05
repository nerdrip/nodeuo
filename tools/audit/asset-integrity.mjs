import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_FALLBACK } from '../../apps/client/src/assets/mobile-atlas.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const defaultAssetDir = fileURLToPath(new URL('../../apps/client/public/assets/', import.meta.url));
const assetDir = resolve(process.env.UO_ASSET_DIR || defaultAssetDir);
const readAssetJson = (name) => JSON.parse(readFileSync(join(assetDir, name), 'utf8'));
function readMobiles() {
  const indexPath = join(assetDir, 'mobiles-atlas-index.json');
  if (!existsSync(indexPath)) return readAssetJson('mobiles-atlas.json');
  const atlas = JSON.parse(readFileSync(indexPath, 'utf8'));
  atlas.bodies = {};
  for (const row of Object.values(atlas.shards ?? {})) {
    const payload = readFileSync(join(assetDir, row.file));
    assert.equal(payload.length, row.bytes, `${row.file} byte size mismatch`);
    assert.equal(createHash('sha256').update(payload).digest('hex'), row.sha256,
      `${row.file} hash mismatch`);
    const shard = JSON.parse(payload.toString('utf8'));
    Object.assign(atlas.bodies, shard.bodies ?? {});
  }
  for (const row of Object.values(atlas.pages ?? {})) {
    const payload = readFileSync(join(assetDir, row.file));
    assert.equal(payload.length, row.bytes, `${row.file} byte size mismatch`);
    assert.equal(createHash('sha256').update(payload).digest('hex'), row.sha256,
      `${row.file} hash mismatch`);
    if (row.ktx2) {
      const compressed = readFileSync(join(assetDir, row.ktx2.file));
      assert.equal(compressed.length, row.ktx2.bytes, `${row.ktx2.file} byte size mismatch`);
      assert.equal(createHash('sha256').update(compressed).digest('hex'), row.ktx2.sha256,
        `${row.ktx2.file} hash mismatch`);
    }
  }
  return atlas;
}
const mobiles = readMobiles();
const statics = readAssetJson('static-atlas.json');
const gumps = readAssetJson('gump-atlas.json');
const land = readAssetJson('land-atlas.json');
const monsters = readJson('../../apps/scripts/src/data/config/monsters.json');
const items = readJson('../../apps/scripts/src/data/config/items.json');

function frameCount(body) {
  let count = 0;
  for (const action of Object.values(body?.actions ?? {})) {
    for (const frames of Object.values(action?.dirs ?? {})) {
      count += Array.isArray(frames) ? frames.length : (frames?.frames?.length ?? 0);
    }
  }
  return count;
}

const fallbacks = new Map(Object.entries(BODY_FALLBACK).map(([body, target]) => [Number(body), target]));

function resolvedBody(body) {
  const alias = mobiles.aliases?.[body];
  const direct = alias?.body ?? alias?.trueBody ?? body;
  if (frameCount(mobiles.bodies?.[direct]) > 0) return { body: direct, via: direct === body ? 'direct' : 'alias' };
  if (frameCount(mobiles.bodies?.[body]) > 0) return { body, via: 'direct' };
  const fallback = fallbacks.get(body);
  if (fallback != null && frameCount(mobiles.bodies?.[fallback]) > 0) return { body: fallback, via: 'fallback' };
  const generic = body < 200 ? 9 : body < 400 ? 226 : null;
  if (generic != null && frameCount(mobiles.bodies?.[generic]) > 0) return { body: generic, via: 'generic' };
  return null;
}

const unresolvedMonsters = [];
const genericMonsters = [];
for (const monster of monsters) {
  const resolved = resolvedBody(monster.body | 0);
  if (!resolved) unresolvedMonsters.push([monster.kind, monster.body]);
  else if (resolved.via === 'generic') genericMonsters.push([monster.kind, monster.body, resolved.body]);
}
assert.deepEqual(unresolvedMonsters, [], `monster bodies without render path: ${JSON.stringify(unresolvedMonsters.slice(0, 20))}`);
assert.deepEqual(genericMonsters, [], `monster bodies using generic art: ${JSON.stringify(genericMonsters.slice(0, 20))}`);
assert.equal(resolvedBody(52)?.body, 51, 'lava snake must resolve to serpent, never daemon');
assert.notEqual(resolvedBody(238)?.body, 226, 'rat fallback must not be horse-sized');

const missingItems = items.filter(({ itemId }) => Number.isInteger(itemId)
  && !statics.tiles?.[itemId]
  && !statics.tiles?.[itemId + 0x4000]);
assert.deepEqual(missingItems, [], `configured items missing static art: ${missingItems.slice(0, 20).map((x) => x.name).join(', ')}`);

assert.ok(Object.keys(gumps.tiles ?? {}).length > 5_000, 'gump atlas unexpectedly incomplete');
assert.ok(Object.keys(statics.tiles ?? {}).length > 35_000, 'static atlas unexpectedly incomplete');
assert.ok(Object.keys(land.tiles ?? {}).length > 4_000, 'land atlas unexpectedly incomplete');
for (const id of [0x0803, 0x0804, 0x0A28, 0x0A30, 0x0FA8, 0x0FAA]) {
  assert.ok(gumps.tiles?.[id], `critical gump 0x${id.toString(16)} is missing`);
}

console.log(`[audit:asset-integrity] ok monsters=${monsters.length} generic=${genericMonsters.length} items=${items.length} gumps=${Object.keys(gumps.tiles).length}`);
if (genericMonsters.length) console.log(`[audit:asset-integrity] generic-fallback sample=${JSON.stringify(genericMonsters.slice(0, 12))}`);
