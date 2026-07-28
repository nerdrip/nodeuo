// Extract Multimap.rle → multimap.png + multimap.json.
//
// CUO `MultiMapLoader.cs`: Multimap.rle is the world-overview grayscale
// map used by the house/boat placement preview. The file format is a
// simple run-length scan: u32 width, u32 height, then bytes where
//   pic  = byte
//   size = pic & 0x7F          — run length
//   col  = (pic & 0x80) != 0   — is the run "colored" (i.e. emit pixels)
// For every colored pixel in the run, increment data[x,y] by 1; otherwise
// just advance the scan cursor. CUO then renders that 8-bit intensity
// buffer through a 31-step gradient out of the .hues palette.
//
// For the browser client we don't need the per-frame view-port slicing;
// we ship the full grid as a grayscale PNG plus a tiny JSON manifest
// recording (w, h). The world-map gump composites it as a backdrop.
//
// Output:
//   multimap.png   — raw grayscale (1 channel) PNG at full resolution
//   multimap.json  — { w, h, max } (max = peak run-stack value)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from './safe-sharp.js';

export async function extractMultimap(srcDir, outDir) {
  // Filename casing varies across UO installs ("Multimap.rle" upper-M).
  const candidates = ['Multimap.rle', 'multimap.rle', 'MultiMap.rle'];
  let path = null;
  for (const name of candidates) {
    const p = join(srcDir, name);
    if (existsSync(p)) { path = p; break; }
  }
  if (!path) return { skipped: true };

  const buf = readFileSync(path);
  if (buf.length < 8) return { skipped: true, reason: 'too small' };

  const w = buf.readInt32LE(0);
  const h = buf.readInt32LE(4);
  if (w < 1 || h < 1 || w > 8192 || h > 8192) {
    return { skipped: true, reason: `bad bounds ${w}×${h}` };
  }

  // 8-bit intensity grid — every "colored" pixel run increments the
  // counter at that position. Values are clamped to 255.
  const data = Buffer.alloc(w * h);
  let max = 1;
  let pos = 8;
  let x = 0, y = 0;
  while (pos < buf.length && y < h) {
    const pic     = buf.readUInt8(pos++);
    const size    = pic & 0x7F;
    const colored = (pic & 0x80) !== 0;
    for (let i = 0; i < size; i++) {
      if (colored && x >= 0 && x < w && y >= 0 && y < h) {
        const idx = y * w + x;
        let v = data[idx];
        if (v < 0xFF) {
          if (v === max) max++;
          v++;
          data[idx] = v;
        }
      }
      x++;
      if (x >= w) { x = 0; y++; }
    }
  }

  // Rescale intensities to a 0..255 grayscale that the browser can use
  // directly. Empty cells stay at 0 (alpha-free border in the gump).
  const scale = max > 0 ? 255 / max : 0;
  const gray = Buffer.alloc(w * h);
  for (let i = 0; i < gray.length; i++) {
    const v = data[i];
    gray[i] = v > 0 ? Math.min(255, Math.round(v * scale)) : 0;
  }

  await sharp(gray, { raw: { width: w, height: h, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, 'multimap.png'));

  writeFileSync(join(outDir, 'multimap.json'), JSON.stringify({ w, h, max }));
  return { w, h, max };
}
