// Extract tiledata.mul → tiledata.json
// (LandTile flags + StaticTile flags / weights / layers / heights / names).
//
// Format (mirrors ClassicUO.Assets/TileDataLoader.cs):
//
// LandTile section: 0x4000 entries, packed in 512 groups of 32 each.
//   group: u32 header + 32 × LandData (26 bytes):
//     u64 flags
//     u16 graphic (textureId)
//     char[20] name
//
// StaticTile section: starts immediately after, in the same `groups of 32 +
// header` pattern, with each entry 37 bytes:
//   u64 flags
//   u8 weight
//   u8 layer
//   u32 count          (rarely used; treated as quality)
//   u16 animId
//   u16 hue
//   u16 lightIndex
//   u8 height
//   char[20] name
//
// We emit a single tiledata.json with per-tile entries; minimal for now —
// just `flags` and `name` for land, plus `flags`, `weight`, `layer`,
// `animId`, `height`, `name` for statics.

import { open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAND_COUNT     = 0x4000; // 16384
// CUO TileDataLoader.cs picks layout via client version, not file size.
// Pre-HSA (client < 7.0.9.0): u32 flags, struct sizes 26 / 37.
// HSA (client >= 7.0.9.0):    u64 flags, struct sizes 30 / 41.
// Empirically: file size 3188736 = HSA (gives 2048 static groups exactly,
// pre-HSA arithmetic doesn't divide evenly). Verified by name decode
// ("grass" at land id 3, "water" at land id 168 only fit HSA offsets).
const PRE_HSA_LAND   = 26;
const HSA_LAND       = 30;
const PRE_HSA_STATIC = 37;
const HSA_STATIC     = 41;

/**
 * @param {string} tiledataMulPath
 * @param {string} outDir
 */
export async function extractTiledata(tiledataMulPath, outDir) {
  const fd = await open(tiledataMulPath, 'r');
  try {
    const stat = await fd.stat();
    const buf = Buffer.alloc(stat.size);
    await fd.read(buf, 0, stat.size, 0);

    // Empirical detection: try HSA layout first (most modern client
    // distributions). If land section + 2048 static groups exactly fills
    // the file, we have HSA. Otherwise fall back to pre-HSA.
    const hsaLandSize = 512 * (4 + 32 * HSA_LAND);
    const hsaRemaining = stat.size - hsaLandSize;
    const hsaStaticGroup = 4 + 32 * HSA_STATIC;
    const isOld = !(hsaRemaining > 0 && hsaRemaining % hsaStaticGroup === 0);
    const flagBytes = isOld ? 4 : 8;
    const landEntry   = isOld ? PRE_HSA_LAND   : HSA_LAND;
    const staticEntry = isOld ? PRE_HSA_STATIC : HSA_STATIC;
    console.log(`[tiledata] layout: ${isOld ? 'pre-HSA (u32 flags)' : 'HSA (u64 flags)'}`);

    /** @type {Array<{flags:number,name:string}>} */
    const land = new Array(LAND_COUNT);
    let off = 0;
    for (let g = 0; g < LAND_COUNT / 32; g++) {
      off += 4; // group header
      for (let i = 0; i < 32; i++) {
        const id = g * 32 + i;
        const flagsLo = buf.readUInt32LE(off + 0);
        const flagsHi = isOld ? 0 : buf.readUInt32LE(off + 4);
        // u16 textureId points into texmaps.mul (stretched-land texture).
        // CUO Land.cs uses TexID == 0 + IsWet to mark "needs slope warp"
        // — we expose texId so the asset-manager can pick the matching
        // texmap atlas slice when rendering a slope.
        const texId = buf.readUInt16LE(off + flagBytes);
        const nameOff = off + flagBytes + 2;
        const name = buf.toString('latin1', nameOff, nameOff + 20)
          .replace(/\0+$/, '').trim();
        land[id] = { flags: flagsLo, flagsHi, texId, name };
        off += landEntry;
      }
    }

    // Statics — read until end of file.
    /** @type {Array<{flags:number,flagsHi:number,weight:number,layer:number,animId:number,height:number,name:string}>} */
    const statics = [];
    while (off + 4 <= buf.length) {
      off += 4; // group header
      for (let i = 0; i < 32; i++) {
        if (off + staticEntry > buf.length) break;
        const flagsLo  = buf.readUInt32LE(off + 0);
        const flagsHi  = isOld ? 0 : buf.readUInt32LE(off + 4);
        const baseOff  = off + flagBytes;
        const weight   = buf.readUInt8(baseOff + 0);
        const layer    = buf.readUInt8(baseOff + 1);
        const quality  = buf.readUInt32LE(baseOff + 2);
        const animId   = buf.readUInt16LE(baseOff + 6);
        const hue      = buf.readUInt16LE(baseOff + 8);
        // Audit rev.4 P2 — expose `lightIndex` so the client can map
        // FLAG_LIGHT_SRC statics to a light.mul emission entry. We
        // were dropping this field on the floor (`_light = …` then
        // unused), so torches couldn't pick a radius without the
        // curated `STATIC_LIGHTS` table.
        const lightIndex = buf.readUInt16LE(baseOff + 10);
        const height   = buf.readUInt8(baseOff + 12);
        const nameOff  = baseOff + 13;
        const name     = buf.toString('latin1', nameOff, nameOff + 20)
          .replace(/\0+$/, '').trim();
        statics.push({ flags: flagsLo, flagsHi, weight, layer, quality, animId, hue, lightIndex, height, name });
        off += staticEntry;
      }
    }

    writeFileSync(
      join(outDir, 'tiledata.json'),
      JSON.stringify({ landCount: land.length, staticCount: statics.length, land, statics }),
    );
    return { landCount: land.length, staticCount: statics.length };
  } finally {
    await fd.close();
  }
}
