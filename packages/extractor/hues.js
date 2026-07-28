// Extract hues.mul → 32-bit ARGB palette JSON.
//
// hues.mul format (mirrors ClassicUO.Assets/HuesLoader.cs):
//   N × HuesGroup, each 708 bytes:
//     u32 header
//     8 × HueEntry (88 bytes each):
//       u16 colors[32]   // 16-bit ARGB1555
//       u16 tableStart
//       u16 tableEnd
//       char[20] name
//
// Total entries = N × 8 hues. The hue id used on the wire indexes by 1 (so
// hue 0 = no tint, hue 1 = first entry, etc.). We emit a flat 32-bit
// palette as a single PNG (hues.png, 32 wide × N×8 tall) plus a JSON with
// names + table bounds — easier for the client to upload as a GPU texture.

import { open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from './safe-sharp.js';

const GROUP_SIZE  = 708;    // bytes
const ENTRY_SIZE  = 88;     // bytes
const ENTRIES_PER_GROUP = 8;

/**
 * @param {string} huesMulPath
 * @param {string} outDir       absolute path; we write hues.png + hues.json
 */
export async function extractHues(huesMulPath, outDir) {
  const fd = await open(huesMulPath, 'r');
  try {
    const stat = await fd.stat();
    const groupCount = Math.floor(stat.size / GROUP_SIZE);
    const totalHues  = groupCount * ENTRIES_PER_GROUP;

    // Palette PNG: width 32, height totalHues. RGBA, premultiplied alpha = 1.
    const palette = Buffer.alloc(32 * totalHues * 4);
    /** @type {{ name:string, tableStart:number, tableEnd:number }[]} */
    const meta = new Array(totalHues);

    const groupBuf = Buffer.alloc(GROUP_SIZE);
    for (let g = 0; g < groupCount; g++) {
      await fd.read(groupBuf, 0, GROUP_SIZE, g * GROUP_SIZE);
      let off = 4; // skip group header u32
      for (let e = 0; e < ENTRIES_PER_GROUP; e++) {
        const hueIndex = g * ENTRIES_PER_GROUP + e;
        const rowStart = hueIndex * 32 * 4;
        for (let c = 0; c < 32; c++) {
          const argb1555 = groupBuf.readUInt16LE(off + c * 2);
          const rgba = color16To32(argb1555);
          palette[rowStart + c * 4 + 0] = (rgba >> 16) & 0xff; // R
          palette[rowStart + c * 4 + 1] = (rgba >>  8) & 0xff; // G
          palette[rowStart + c * 4 + 2] =  rgba        & 0xff; // B
          palette[rowStart + c * 4 + 3] = 255;
        }
        const ts = groupBuf.readUInt16LE(off + 64);
        const te = groupBuf.readUInt16LE(off + 66);
        const name = groupBuf.toString('latin1', off + 68, off + 88).replace(/\0+$/, '').trim();
        meta[hueIndex] = { name, tableStart: ts, tableEnd: te };
        off += ENTRY_SIZE;
      }
    }

    await sharp(palette, { raw: { width: 32, height: totalHues, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, 'hues.png'));

    writeFileSync(
      join(outDir, 'hues.json'),
      JSON.stringify({ count: totalHues, width: 32, height: totalHues, hues: meta }),
    );

    return { count: totalHues };
  } finally {
    await fd.close();
  }
}

/** ARGB1555 → 0x00RRGGBB (drop the 1-bit alpha). */
function color16To32(c) {
  const r5 = (c >> 10) & 0x1f;
  const g5 = (c >>  5) & 0x1f;
  const b5 =  c        & 0x1f;
  // Standard 5-to-8 expansion: x << 3 | x >> 2.
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g5 << 3) | (g5 >> 2);
  const b = (b5 << 3) | (b5 >> 2);
  return (r << 16) | (g << 8) | b;
}
