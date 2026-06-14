// Extract light.mul + lightidx.mul → lights.json.
// Mirrors ClassicUO.Assets/LightsLoader.cs.
//
// File layout (UOFileMul + index):
//   lightidx.mul: array of IndexEntry (12 bytes each)
//                   u32 offset   — byte offset into light.mul
//                   u32 length   — byte length (= width * height)
//                   u32 extra    — high u16 = width, low u16 = height
//   light.mul   : raw 8-bit grayscale pixels. Each value is intensity
//                 0..31 (5 bits). Values > 31 are bit-inverted
//                 (val = ~val & 0x1F) — CUO's "negative light" trick.
//
// Output (lights.json):
//   { count: <n>, entries: { <id>: { w, h, pixels: <base64-u8> } } }
//
// We store the raw 0..31 intensity buffer base64-encoded; the client
// upgrades each pixel to rgb24 (val<<19 | val<<11 | val<<3) at sample
// time, matching CUO's `LightInfo.Pixels` computation. There are at
// most 100 light templates (CUO MAX_LIGHTS_DATA_INDEX_COUNT) so the
// JSON stays small (~50 KB).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LIGHTS = 100;
const IDX_ENTRY_SIZE = 12;

export function extractLights(srcDir, outDir) {
  const idxPath = join(srcDir, 'lightidx.mul');
  const datPath = join(srcDir, 'light.mul');
  if (!existsSync(idxPath) || !existsSync(datPath)) {
    return { count: 0, skipped: true };
  }
  const idx = readFileSync(idxPath);
  const dat = readFileSync(datPath);

  /** @type {Record<number, {w:number,h:number,pixels:string}>} */
  const entries = {};
  let realCount = 0;

  const maxEntries = Math.min(MAX_LIGHTS, Math.floor(idx.length / IDX_ENTRY_SIZE));
  for (let id = 0; id < maxEntries; id++) {
    const off = id * IDX_ENTRY_SIZE;
    const offset = idx.readInt32LE(off);
    const length = idx.readInt32LE(off + 4);
    const extra  = idx.readUInt32LE(off + 8);
    // Empty / removed entries — CUO uses -1 sentinel offset.
    if (offset < 0 || length <= 0) continue;
    const w = (extra >> 16) & 0xFFFF;
    const h = extra & 0xFFFF;
    if (w === 0 || h === 0) continue;
    if (offset + length > dat.length) continue;
    if (length !== w * h) {
      // Some legacy lightidx entries declare length=0 even with valid
      // w/h — fall back to w*h. Skip if neither matches.
      if (length !== 0) continue;
    }
    // Slice + sanitize intensity bytes (collapse the negative-light
    // bit-inversion CUO does at sample time so the client doesn't
    // need to repeat it).
    const buf = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) {
      let v = dat.readUInt8(offset + i);
      if (v > 0x1F) v = (~v) & 0x1F;
      buf[i] = v & 0x1F;
    }
    entries[id] = { w, h, pixels: buf.toString('base64') };
    realCount++;
  }

  writeFileSync(join(outDir, 'lights.json'), JSON.stringify({
    count: realCount,
    entries,
  }));
  return { count: realCount };
}
