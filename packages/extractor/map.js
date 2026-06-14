// Extract map{N} + statics{N} → flat .bin files the client streams via
// HTTP Range. Mirrors ClassicUO.Assets/MapLoader.cs.
//
// map0 layout (Felucca pre-ML):
//   width  = 6144 tiles → 768 blocks across
//   height = 4096 tiles → 512 blocks down
//   total  = 393216 blocks of 8×8 LandTiles
//   block  = u32 header + 64 × { u16 graphic; i8 z }  =  196 bytes
//
// In `map0LegacyMUL.uop` blocks are sharded into UOP entries with
// `block >> 12` (4096 blocks per UOP entry, ~803 KiB compressed each).
// We just decompress every entry and concatenate.
//
// Statics (statics0.mul + staidx0.mul):
//   staidx0 is 393216 × 12-byte entries (offset, size, extra)
//   statics0 is variable — each block's chunk is a list of:
//     u16 graphic; u8 x; u8 y; i8 z; u16 hue
// We pack:
//   statics0.bin  = concatenated content (untouched)
//   staidx0.bin   = u32 little-endian (offset, size) pairs for each block
//                   (offset = byte offset into statics0.bin; 0xFFFFFFFF = no statics)

import { open, writeFile } from 'node:fs/promises';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openUop, readEntryContent } from './uop.js';

// Map dimensions per facet (ClassicUO canonical, post-ML/SA layout):
//   0 Felucca   7168 × 4096
//   1 Trammel   7168 × 4096
//   2 Ilshenar  2304 × 1600
//   3 Malas     2560 × 2048
//   4 Tokuno    1448 × 1448
//   5 TerMur    1280 × 4096   (Stygian Abyss)
//
// Extractor probes each facet and skips silently if the .uop / .mul source
// is missing. Caller passes `facet` 0..5 individually or via a helper that
// loops 0..5 (see extract.js).
const FACETS = {
  0: { width: 7168, height: 4096, name: 'Felucca'  },
  1: { width: 7168, height: 4096, name: 'Trammel'  },
  2: { width: 2304, height: 1600, name: 'Ilshenar' },
  3: { width: 2560, height: 2048, name: 'Malas'    },
  4: { width: 1448, height: 1448, name: 'Tokuno'   },
  5: { width: 1280, height: 4096, name: 'TerMur'   },
};

export const FACET_IDS = [0, 1, 2, 3, 4, 5];
export function facetName(id) { return FACETS[id]?.name ?? `Facet${id}`; }
const BLOCK_SIZE = 196;

/** Map width/height in *blocks*. */
function blocksOf(facet) {
  const f = FACETS[facet];
  return { bw: f.width / 8, bh: f.height / 8, total: (f.width / 8) * (f.height / 8) };
}

export async function extractMap(src, outDir, facet = 0) {
  const { bw, bh, total } = blocksOf(facet);
  // Some shards keep facet 1+ in .mul format (e.g. classic clients).
  // Probe the canonical UOP first, then fall back to a flat map{N}.mul.
  const uopPath = join(src, `map${facet}LegacyMUL.uop`);
  const mulPath = join(src, `map${facet}.mul`);
  if (!existsSync(uopPath)) {
    if (existsSync(mulPath)) {
      // Direct copy + meta — .mul is already the canonical block stream.
      const fd = await open(mulPath, 'r');
      try {
        const stat = await fd.stat();
        const buf  = Buffer.alloc(stat.size);
        await fd.read(buf, 0, stat.size, 0);
        await writeFile(join(outDir, `map${facet}.bin`), buf);
        writeFileSync(
          join(outDir, `map${facet}.json`),
          JSON.stringify({
            width: FACETS[facet].width, height: FACETS[facet].height,
            blocksWide: bw, blocksTall: bh, blockBytes: BLOCK_SIZE,
            totalBlocks: total,
          }),
        );
        return { written: Math.min(total, Math.floor(stat.size / BLOCK_SIZE)), total };
      } finally { await fd.close(); }
    }
    return { written: 0, total, skipped: true };
  }
  const { fd, entries } = await openUop(uopPath);
  try {
    const out = Buffer.alloc(total * BLOCK_SIZE);

    // For UOP map files entries are indexed sequentially (file `00000000.dat`
    // = blocks 0..4095, `00000001.dat` = blocks 4096..8191, etc.). The hash
    // table will give us each entry; we just iterate entries in order they
    // appear (CUO sorts by their offset; for our extraction the order
    // doesn't matter as long as we know the cluster index).
    //
    // Easiest: hash each candidate cluster name 0..maxCluster and place its
    // content into the right slot.
    const { hashFileName } = await import('./hash.js');
    /** @type {Map<bigint, import('./uop.js').UopEntry>} */
    const byHash = new Map();
    for (const e of entries) byHash.set(e.hash, e);

    const blocksPerCluster = 4096;
    const clusterCount = Math.ceil(total / blocksPerCluster);
    let written = 0;

    for (let c = 0; c < clusterCount; c++) {
      const name = `build/map${facet}legacymul/${String(c).padStart(8, '0')}.dat`;
      const e = byHash.get(hashFileName(name));
      if (!e) continue;
      const content = await readEntryContent(fd, e);
      const startBlock = c * blocksPerCluster;
      const blockCount = Math.min(blocksPerCluster, total - startBlock);
      content.copy(out, startBlock * BLOCK_SIZE, 0, blockCount * BLOCK_SIZE);
      written += blockCount;
    }

    await writeFile(join(outDir, `map${facet}.bin`), out);
    writeFileSync(
      join(outDir, `map${facet}.json`),
      JSON.stringify({
        width: FACETS[facet].width,
        height: FACETS[facet].height,
        blocksWide: bw,
        blocksTall: bh,
        blockBytes: BLOCK_SIZE,
        totalBlocks: total,
      }),
    );
    return { written, total };
  } finally {
    await fd.close();
  }
}

export async function extractStatics(src, outDir, facet = 0) {
  const { total, bw, bh } = blocksOf(facet);
  const idxPath = join(src, `staidx${facet}.mul`);
  const datPath = join(src, `statics${facet}.mul`);
  if (!existsSync(idxPath) || !existsSync(datPath)) {
    return { blocks: 0, datBytes: 0, skipped: true };
  }
  const idxFd = await open(idxPath, 'r');
  const datFd = await open(datPath, 'r');
  try {
    const idxStat = await idxFd.stat();
    const idxBuf  = Buffer.alloc(idxStat.size);
    await idxFd.read(idxBuf, 0, idxStat.size, 0);

    const blockEntries = Math.min(total, idxStat.size / 12);
    // Build a compact 8-byte-per-block index file: u32 offsetInDat, u32 size.
    // Skip blocks with `position === 0xFFFFFFFF` or `size <= 0` (mark as 0xFFFFFFFF).
    const compactIdx = Buffer.alloc(total * 8);
    let totalDatBytes = 0;
    for (let b = 0; b < blockEntries; b++) {
      const pos  = idxBuf.readUInt32LE(b * 12 + 0);
      const size = idxBuf.readInt32LE (b * 12 + 4);
      if (pos === 0xFFFFFFFF || size <= 0) {
        compactIdx.writeUInt32LE(0xFFFFFFFF, b * 8);
        compactIdx.writeUInt32LE(0,          b * 8 + 4);
      } else {
        compactIdx.writeUInt32LE(pos,  b * 8);
        compactIdx.writeUInt32LE(size, b * 8 + 4);
        if (pos + size > totalDatBytes) totalDatBytes = pos + size;
      }
    }
    // Mark trailing blocks (if any) as empty.
    for (let b = blockEntries; b < total; b++) {
      compactIdx.writeUInt32LE(0xFFFFFFFF, b * 8);
      compactIdx.writeUInt32LE(0,          b * 8 + 4);
    }

    const datStat = await datFd.stat();
    const datBuf  = Buffer.alloc(datStat.size);
    await datFd.read(datBuf, 0, datStat.size, 0);

    await writeFile(join(outDir, `staidx${facet}.bin`), compactIdx);
    await writeFile(join(outDir, `statics${facet}.bin`), datBuf);
    writeFileSync(
      join(outDir, `statics${facet}.json`),
      JSON.stringify({
        blocksWide: bw, blocksTall: bh, totalBlocks: total,
        idxFile: `staidx${facet}.bin`, datFile: `statics${facet}.bin`,
        idxBytesPerBlock: 8, // u32 offset + u32 size
        staticBytes: 7,      // u16 graphic + u8 x + u8 y + i8 z + u16 hue
      }),
    );
    return { blocks: blockEntries, datBytes: datStat.size };
  } finally {
    await idxFd.close();
    await datFd.close();
  }
}
