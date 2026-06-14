// Extract radarcol.mul → radarcol.json for accurate minimap / world-map
// colours.
//
// `radarcol.mul` is a flat 65 536 × u16 ARGB1555 palette: index N = the
// colour to use for tile id N on the minimap. The first 0x4000 entries
// cover land tiles, 0x4000..0xFFFF cover statics. Mirrors CUO
// `RadarLoader.cs`.
//
// We emit `radarcol.json`:
//   { land: number[16384], static: number[49152] }
// Each entry is the 16-bit ARGB1555 colour value the client can convert
// to RGB on demand. Storing the raw u16 keeps the JSON small (~250 KB
// gzipped) — compared to expanding to RGB triplets which would balloon
// it 6× for no real benefit.

import fs from 'node:fs/promises';
import { join } from 'node:path';

const TOTAL_ENTRIES = 0x10000;
const LAND_COUNT    = 0x4000;

export async function extractRadarcol(src, outDir) {
  const path = join(src, 'radarcol.mul');
  const buf = await fs.readFile(path);
  if (buf.length < TOTAL_ENTRIES * 2) {
    throw new Error(`radarcol.mul truncated: ${buf.length} bytes (expected ≥${TOTAL_ENTRIES * 2})`);
  }
  const land   = new Array(LAND_COUNT);
  const stat   = new Array(TOTAL_ENTRIES - LAND_COUNT);
  for (let i = 0; i < LAND_COUNT; i++) {
    land[i] = buf.readUInt16LE(i * 2);
  }
  for (let i = 0; i < stat.length; i++) {
    stat[i] = buf.readUInt16LE((LAND_COUNT + i) * 2);
  }
  await fs.writeFile(
    join(outDir, 'radarcol.json'),
    JSON.stringify({ land, static: stat }),
  );
  return { count: TOTAL_ENTRIES, landCount: LAND_COUNT };
}
