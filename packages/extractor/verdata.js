// Extract verdata.mul → verdata.json.
// Mirrors ClassicUO Verdata patch container.
//
// File layout:
//   u32 patchCount
//   { u32 fileId, u32 blockId, u32 fileOffset, u32 length, u32 extra,
//     u8 something } * patchCount
//   <patch blobs at fileOffset..fileOffset+length>
//
// fileId codes (subset; canon UO):
//    0 = map0       4 = art        7 = gumpart   10 = unifont0
//    1 = staidx0    5 = tiledata   8 = multi    11..14 = unifont1..4
//    2 = statics0   6 = anim       9 = skills    15 = light
//   16 = soundidx  18 = ascii fonts            19 = hues
//   20 = anim2     21 = anim3      22 = anim4    23 = anim5
//   30 = multimap  31 = animdata
//
// Output (verdata.json):
//   { count, patches: [ { fileId, blockId, extra, data: <base64> } ] }
//
// Client uses verdata.json to override base assets at runtime (gump
// art / hue table / hue range / multi composition). Shards that ship
// custom verdata can hot-patch without rebuilding the canonical
// atlas; the client merges before sprite acquisition.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PATCH_REC_SIZE = 21; // 5×u32 + 1×u8

export function extractVerdata(srcDir, outDir) {
  const path = join(srcDir, 'verdata.mul');
  if (!existsSync(path)) return { count: 0, skipped: true };
  const buf = readFileSync(path);
  if (buf.length < 4) return { count: 0, skipped: true };

  const patchCount = buf.readInt32LE(0);
  if (patchCount <= 0 || patchCount > 1_000_000) {
    return { count: 0, skipped: true };
  }
  const tableBase = 4;
  const tableEnd = tableBase + patchCount * PATCH_REC_SIZE;
  if (tableEnd > buf.length) return { count: 0, skipped: true };

  const patches = [];
  for (let i = 0; i < patchCount; i++) {
    const r = tableBase + i * PATCH_REC_SIZE;
    const fileId = buf.readUInt32LE(r);
    const blockId = buf.readUInt32LE(r + 4);
    const fileOffset = buf.readUInt32LE(r + 8);
    const length = buf.readUInt32LE(r + 12);
    const extra = buf.readUInt32LE(r + 16);
    // r+20 = u8 reserved (ignored)
    if (length === 0) {
      patches.push({ fileId, blockId, extra, data: '' });
      continue;
    }
    if (fileOffset + length > buf.length) continue;
    const blob = buf.slice(fileOffset, fileOffset + length);
    patches.push({
      fileId, blockId, extra,
      data: blob.toString('base64'),
    });
  }

  writeFileSync(join(outDir, 'verdata.json'), JSON.stringify({
    count: patches.length,
    patches,
  }));
  return { count: patches.length };
}
