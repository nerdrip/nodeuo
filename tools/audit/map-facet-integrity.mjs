import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const url = (name) => new URL(`../../apps/client/public/assets/${name}`, import.meta.url);
let sampledBlocks = 0;
let indexedStaticBlocks = 0;

for (let facet = 0; facet <= 5; facet++) {
  const mapMeta = JSON.parse(readFileSync(url(`map${facet}.json`), 'utf8'));
  const staticsMeta = JSON.parse(readFileSync(url(`statics${facet}.json`), 'utf8'));
  const mapBytes = statSync(url(`map${facet}.bin`)).size;
  const idx = readFileSync(url(`staidx${facet}.bin`));
  const dataBytes = statSync(url(`statics${facet}.bin`)).size;
  assert.equal(mapMeta.totalBlocks, mapMeta.blocksWide * mapMeta.blocksTall, `facet ${facet} map dimensions`);
  assert.equal(mapBytes, mapMeta.totalBlocks * mapMeta.blockBytes, `facet ${facet} map byte length`);
  assert.equal(staticsMeta.totalBlocks, mapMeta.totalBlocks, `facet ${facet} static/map block count`);
  assert.equal(idx.length, staticsMeta.totalBlocks * 8, `facet ${facet} staidx byte length`);

  // Validate every static index entry: corrupted offsets are the source of
  // random doors/signs/art appearing at otherwise valid coordinates.
  for (let block = 0; block < staticsMeta.totalBlocks; block++) {
    const at = block * 8;
    const offset = idx.readUInt32LE(at);
    const size = idx.readUInt32LE(at + 4);
    if (offset === 0xffffffff || size === 0) continue;
    indexedStaticBlocks++;
    assert.equal(size % 7, 0, `facet ${facet} static block ${block} record alignment`);
    assert.ok(offset + size <= dataBytes, `facet ${facet} static block ${block} exceeds data file`);
  }

  const map = readFileSync(url(`map${facet}.bin`));
  const stride = Math.max(1, Math.floor(mapMeta.totalBlocks / 4096));
  for (let block = 0; block < mapMeta.totalBlocks; block += stride) {
    const base = block * mapMeta.blockBytes;
    assert.ok(base + 196 <= map.length, `facet ${facet} sampled block ${block} truncated`);
    for (let tile = 0; tile < 64; tile += 9) {
      const tileId = map.readUInt16LE(base + 4 + tile * 3);
      assert.ok(tileId <= 0x3fff, `facet ${facet} block ${block} invalid land id ${tileId}`);
    }
    sampledBlocks++;
  }
}

console.log(`[audit:map-facets] ok facets=6 samples=${sampledBlocks} staticBlocks=${indexedStaticBlocks}`);
