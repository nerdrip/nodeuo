// UOP container reader. Mirrors ClassicUO.IO/UOFileUop.cs.
//
// Layout (LE):
//   char[4] magic   = 'M','Y','P','\0'
//   u32 version     (>= 5 typical)
//   u32 formatTimestamp  (often 0xFD23EC43)
//   u64 startOffset (offset of first block)
//   u32 maxPerBlock (files per block)
//   u32 fileCount
//
// Block (read while block != 0):
//   u32 fileCount
//   u64 nextBlock
//   filesPerBlock × {
//     u64 dataOffset
//     u32 headerLength    (bytes before content; usually 0)
//     u32 compressedSize
//     u32 decompressedSize
//     u64 hash            (FileNameHasher of virtual filename)
//     u32 dataHash        (Adler32; we ignore)
//     u16 compressionFlag (0 = none, 1 = zlib)
//   }
//
// `readAll(uopPath, namePattern)` walks every block and inflates each
// file. `namePattern` is a `printf`-style template like
// `build/artlegacymul/%08d.tga`; we hash candidate names 0..fileCount and
// match them to entries.
//
// For map UOPs the layout's a bit different — we expose a generic
// `readEntries` that returns raw entries without name resolution, and let
// the caller hash whatever names it wants.

import { open } from 'node:fs/promises';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { hashFileName } from './hash.js';
import { bwtDecompress } from './bwt.js';

/**
 * Open a UOP file, walk every block, return the raw entry list.
 *
 * @param {string} uopPath
 * @returns {Promise<{ fd: import('node:fs/promises').FileHandle, entries: UopEntry[], totalFiles:number }>}
 */
export async function openUop(uopPath) {
  const fd = await open(uopPath, 'r');
  const stat = await fd.stat();
  const totalSize = stat.size;

  const headerBuf = Buffer.alloc(28);
  await fd.read(headerBuf, 0, 28, 0);
  const magic = headerBuf.readUInt32LE(0);
  if (magic !== 0x0050594D) { // 'MYP\0'
    await fd.close();
    throw new Error(`${uopPath}: not a UOP (magic = 0x${magic.toString(16)})`);
  }
  // version    = headerBuf.readUInt32LE(4)
  // timestamp  = headerBuf.readUInt32LE(8)
  let blockOffset = Number(headerBuf.readBigUInt64LE(12));
  // const maxPerBlock = headerBuf.readUInt32LE(20);
  // const totalFiles  = headerBuf.readUInt32LE(24);

  /** @type {UopEntry[]} */
  const entries = [];
  while (blockOffset !== 0 && blockOffset < totalSize) {
    const blkHeader = Buffer.alloc(12);
    await fd.read(blkHeader, 0, 12, blockOffset);
    const fileCount   = blkHeader.readUInt32LE(0);
    const nextBlock   = Number(blkHeader.readBigUInt64LE(4));
    const filesBuf    = Buffer.alloc(fileCount * 34);
    await fd.read(filesBuf, 0, filesBuf.length, blockOffset + 12);
    let p = 0;
    for (let i = 0; i < fileCount; i++) {
      entries.push({
        dataOffset:        Number(filesBuf.readBigUInt64LE(p +  0)),
        headerLength:             filesBuf.readUInt32LE(p +  8),
        compressedSize:           filesBuf.readUInt32LE(p + 12),
        decompressedSize:         filesBuf.readUInt32LE(p + 16),
        hash:                     filesBuf.readBigUInt64LE(p + 20),
        dataHash:                 filesBuf.readUInt32LE(p + 28),
        compressionFlag:          filesBuf.readUInt16LE(p + 32),
      });
      p += 34;
    }
    blockOffset = nextBlock;
  }
  return { fd, entries, totalFiles: entries.length };
}

/**
 * Read & decompress a single UOP entry's content.
 * @param {import('node:fs/promises').FileHandle} fd
 * @param {UopEntry} entry
 * @returns {Promise<Buffer>}  decompressed content (sized to decompressedSize)
 */
export async function readEntryContent(fd, entry) {
  if (entry.compressedSize <= 0) return Buffer.alloc(0);
  const raw = Buffer.alloc(entry.compressedSize);
  await fd.read(raw, 0, raw.length, entry.dataOffset + entry.headerLength);
  // Compression flags (mirror ClassicUO.IO/CompressionType enum). The
  // header byte distinguishes raw deflate vs. zlib-with-header — some UOPs
  // (notably MultiCollection.uop) keep the zlib magic in spite of flag=1.
  const isZlib = raw[0] === 0x78;
  switch (entry.compressionFlag) {
    case 0: return raw;
    case 1: return isZlib ? inflateSync(raw) : inflateRawSync(raw);
    case 3: return bwtDecompress(inflateSync(raw));
    default:
      try { return isZlib ? inflateSync(raw) : inflateRawSync(raw); }
      catch { return raw; }
  }
}

/**
 * Resolve UOP files via a printf-style filename template.
 *
 * @param {string} uopPath
 * @param {string} template       e.g. 'build/artlegacymul/%08d.tga'
 * @param {number} maxIndex       upper exclusive bound (CUO uses fileCount + 1).
 * @param {number} [extension]    digit-formatting (for snprintf %08d) — included in template.
 * @returns {Promise<{ fd: any, byIndex: (UopEntry|null)[] }>}
 */
export async function openUopIndexed(uopPath, template, maxIndex) {
  const { fd, entries } = await openUop(uopPath);
  /** @type {Map<bigint, UopEntry>} */
  const byHash = new Map();
  for (const e of entries) byHash.set(e.hash, e);
  const byIndex = new Array(maxIndex).fill(null);
  for (let i = 0; i < maxIndex; i++) {
    const name = sprintf(template, i);
    const h = hashFileName(name);
    const e = byHash.get(h);
    if (e) byIndex[i] = e;
  }
  return { fd, byIndex };
}

/** Minimal `%0Nd` and `%d` substitution. We don't need full printf. */
function sprintf(template, n) {
  return template.replace(/%(0?\d*)d/, (_m, pad) => {
    const s = String(n);
    if (!pad || pad === '0') return s;
    if (pad.startsWith('0')) return s.padStart(parseInt(pad, 10), '0');
    return s.padStart(parseInt(pad, 10), ' ');
  });
}

/**
 * @typedef {Object} UopEntry
 * @property {number} dataOffset
 * @property {number} headerLength
 * @property {number} compressedSize
 * @property {number} decompressedSize
 * @property {bigint} hash
 * @property {number} dataHash
 * @property {number} compressionFlag
 */
