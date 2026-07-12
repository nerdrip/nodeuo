import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression fixture taken from the reported Moonglow artefact screenshot.
// It validates the exact disk blocks and atlas coverage independently of the
// renderer, making chunk/index extraction regressions immediately visible.
const FACET = 1;
const CENTER_X = 4452;
const CENTER_Y = 1164;
const RADIUS = 16;
const root = fileURLToPath(new URL('../public/assets/', import.meta.url));

const paths = {
  mapMeta: `${root}map${FACET}.json`,
  map: `${root}map${FACET}.bin`,
  staticsMeta: `${root}statics${FACET}.json`,
  staidx: `${root}staidx${FACET}.bin`,
  statics: `${root}statics${FACET}.bin`,
  landAtlas: `${root}land-atlas.json`,
  staticAtlas: `${root}static-atlas.json`,
};

for (const path of Object.values(paths)) assert.ok(existsSync(path), `missing map QA asset: ${path}`);

const mapMeta = JSON.parse(readFileSync(paths.mapMeta));
const staticsMeta = JSON.parse(readFileSync(paths.staticsMeta));
const landAtlas = JSON.parse(readFileSync(paths.landAtlas));
const staticAtlas = JSON.parse(readFileSync(paths.staticAtlas));
const map = readFileSync(paths.map);
const staidx = readFileSync(paths.staidx);
const statics = readFileSync(paths.statics);

assert.equal(map.length, mapMeta.totalBlocks * mapMeta.blockBytes, 'map slab length must match metadata');
assert.equal(staidx.length, staticsMeta.totalBlocks * staticsMeta.idxBytesPerBlock, 'static index length must match metadata');

const blockIndex = (cx, cy) => cx * mapMeta.blocksTall + cy;
const landAt = (x, y) => {
  const block = blockIndex(x >> 3, y >> 3);
  const offset = block * mapMeta.blockBytes + 4 + (((y & 7) * 8 + (x & 7)) * 3);
  return { id: map.readUInt16LE(offset), z: map.readInt8(offset + 2) };
};

let landCount = 0;
const landPages = new Set();
for (let y = CENTER_Y - RADIUS; y <= CENTER_Y + RADIUS; y++) {
  for (let x = CENTER_X - RADIUS; x <= CENTER_X + RADIUS; x++) {
    const tile = landAt(x, y);
    const atlas = landAtlas.tiles[tile.id];
    assert.ok(atlas, `land 0x${tile.id.toString(16)} at ${x},${y} missing from atlas`);
    assert.ok(tile.z >= -128 && tile.z <= 127, `invalid land Z at ${x},${y}`);
    landPages.add(atlas.page);
    landCount++;
  }
}

let staticCount = 0;
const staticPages = new Set();
const seenStaticIds = new Set();
const cx0 = (CENTER_X - RADIUS) >> 3;
const cy0 = (CENTER_Y - RADIUS) >> 3;
const cx1 = (CENTER_X + RADIUS) >> 3;
const cy1 = (CENTER_Y + RADIUS) >> 3;
for (let cy = cy0; cy <= cy1; cy++) {
  for (let cx = cx0; cx <= cx1; cx++) {
    const block = blockIndex(cx, cy);
    const idxOffset = block * 8;
    const offset = staidx.readUInt32LE(idxOffset);
    const size = staidx.readUInt32LE(idxOffset + 4);
    if (offset === 0xffffffff || size === 0) continue;
    assert.equal(size % 7, 0, `static block ${cx},${cy} has a partial record`);
    assert.ok(offset + size <= statics.length, `static block ${cx},${cy} exceeds statics slab`);
    for (let i = 0; i < size; i += 7) {
      const id = statics.readUInt16LE(offset + i);
      const localX = statics[offset + i + 2];
      const localY = statics[offset + i + 3];
      assert.ok(localX < 8 && localY < 8, `static 0x${id.toString(16)} escapes chunk ${cx},${cy}`);
      const atlas = staticAtlas.tiles[id] ?? staticAtlas.tiles[id + 0x4000];
      assert.ok(atlas, `static 0x${id.toString(16)} at chunk ${cx},${cy} missing from atlas`);
      seenStaticIds.add(id);
      staticPages.add(atlas.page);
      staticCount++;
    }
  }
}

// Pin the characteristic road + Moonglow roof content from the screenshot so
// an accidental facet/block-order swap cannot pass on generic non-empty data.
assert.ok([0x03e9, 0x03ea, 0x03eb, 0x03ec].includes(landAt(CENTER_X, CENTER_Y).id));
assert.ok(seenStaticIds.has(0x05ce) && seenStaticIds.has(0x05cf) && seenStaticIds.has(0x05d0));

console.log(`[smoke:map-coordinate] ok facet=${FACET} center=${CENTER_X},${CENTER_Y} land=${landCount} statics=${staticCount} pages=${landPages.size}+${staticPages.size}`);
