// Extract MultiCollection.uop (or multi.mul/idx) → multi.json.
//
// Each multi (house / boat) is an array of relative tiles:
//   { id, x, y, z, visible }
// Mirrors ClassicUO.Assets/MultiLoader.cs (both UOP and MUL paths).

import { writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openUopIndexed, readEntryContent } from './uop.js';

const MULTI_COUNT = 0x4000;

export async function extractMulti(srcDir, outDir) {
  /** @type {Record<number, {id:number,x:number,y:number,z:number,visible:boolean}[]>} */
  const multis = {};

  const uopPath = join(srcDir, 'MultiCollection.uop');
  if (existsSync(uopPath)) {
    const { fd, byIndex } = await openUopIndexed(
      uopPath, 'build/multicollection/%06d.bin', MULTI_COUNT,
    );
    try {
      for (let id = 0; id < MULTI_COUNT; id++) {
        const e = byIndex[id];
        if (!e || e.decompressedSize <= 8) continue;
        let buf;
        try { buf = await readEntryContent(fd, e); }
        catch { continue; } // skip corrupt entries (flag drift between client builds)
        // u32 unknown + i32 count + count × MultiBlockNew
        if (buf.length < 8) continue;
        const count = buf.readInt32LE(4);
        const tiles = [];
        let p = 8;
        for (let i = 0; i < count; i++) {
          if (p + 16 > buf.length) break;
          const tileId = buf.readUInt16LE(p);     p += 2;
          const x      = buf.readInt16LE(p);      p += 2;
          const y      = buf.readInt16LE(p);      p += 2;
          const z      = buf.readInt16LE(p);      p += 2;
          const flags  = buf.readUInt16LE(p);     p += 2;
          const unk    = buf.readUInt32LE(p);     p += 4;
          if (unk > 0) p += unk * 4; // skip "unknown" payload
          tiles.push({ id: tileId, x, y, z, visible: flags === 0 || flags === 0x100 });
        }
        if (tiles.length > 0) multis[id] = tiles;
      }
    } finally {
      await fd.close();
    }
  } else {
    // .mul fallback (older clients)
    const mulPath = join(srcDir, 'multi.mul');
    const idxPath = join(srcDir, 'multi.idx');
    const mulFd = await open(mulPath, 'r');
    const idxFd = await open(idxPath, 'r');
    try {
      const idxStat = await idxFd.stat();
      const idxBuf = Buffer.alloc(idxStat.size);
      await idxFd.read(idxBuf, 0, idxStat.size, 0);
      const entryCount = Math.floor(idxStat.size / 12);
      for (let id = 0; id < entryCount; id++) {
        const pos  = idxBuf.readUInt32LE(id * 12);
        const size = idxBuf.readInt32LE (id * 12 + 4);
        if (pos === 0xFFFFFFFF || size <= 0) continue;
        const buf = Buffer.alloc(size);
        await mulFd.read(buf, 0, size, pos);
        // CV >= 7.0.9 uses 14-byte blocks; older = 12-byte. We try the
        // newer layout first and fall back if the size isn't a multiple.
        let blockSize = 14;
        if (size % blockSize !== 0) blockSize = 12;
        const count = Math.floor(size / blockSize);
        const tiles = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
          const tileId = buf.readUInt16LE(p + 0);
          const x      = buf.readInt16LE (p + 2);
          const y      = buf.readInt16LE (p + 4);
          const z      = buf.readInt16LE (p + 6);
          const flags  = buf.readUInt32LE(p + 8);
          tiles.push({ id: tileId, x, y, z, visible: flags !== 0 });
          p += blockSize;
        }
        multis[id] = tiles;
      }
    } finally {
      await mulFd.close();
      await idxFd.close();
    }
  }

  writeFileSync(join(outDir, 'multi.json'), JSON.stringify({
    count: Object.keys(multis).length, multis,
  }));
  return { count: Object.keys(multis).length };
}
