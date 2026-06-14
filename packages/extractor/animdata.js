// Extract animdata.mul → animdata.json.
// Mirrors ClassicUO.Assets/AnimDataLoader.cs.
//
// For each tile graphic id (0..0xFFFF) the file holds a frame table:
//   sbyte[64] FrameData    — relative graphic offsets per frame
//   u8 unknown
//   u8 FrameCount          — frames in this loop
//   u8 FrameInterval       — ms between frames
//   u8 FrameStart          — initial offset
// Position = `graphic * 68 + 4 * ((graphic >> 3) + 1)` (header dwords).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENTRY_SIZE = 68;
const MAX_GRAPHIC = 0x10000;

export function extractAnimData(srcDir, outDir) {
  const buf = readFileSync(join(srcDir, 'animdata.mul'));
  /** @type {Record<number, {start:number, count:number, interval:number, frames:number[]}>} */
  const entries = {};
  for (let g = 0; g < MAX_GRAPHIC; g++) {
    const pos = g * ENTRY_SIZE + 4 * ((g >> 3) + 1);
    if (pos + ENTRY_SIZE > buf.length) break;
    // FrameData[64] (signed bytes), then 4 small bytes.
    const frames = [];
    for (let i = 0; i < 64; i++) frames.push(buf.readInt8(pos + i));
    /* const unk    = buf.readUInt8(pos + 64); */
    const count    = buf.readUInt8(pos + 65);
    const interval = buf.readUInt8(pos + 66);
    const start    = buf.readUInt8(pos + 67);
    if (count <= 0) continue;
    // Trim frame list to its actual length.
    entries[g] = { start, count, interval, frames: frames.slice(0, count) };
  }
  writeFileSync(join(outDir, 'animdata.json'), JSON.stringify({
    count: Object.keys(entries).length, entries,
  }));
  return { count: Object.keys(entries).length };
}
