// UOP animation reader.
//
// Post-AOS UO clients ship `AnimationFrame{1..6}.uop` (no 5 in any data
// set we've seen) alongside the legacy `anim*.mul` files. Many bodies —
// every Stygian Abyss creature, all post-AOS reskins of older mobs, the
// new equipment art — moved into the UOP containers and the matching
// MUL idx slot was either zeroed out (size = 0xFFFFFFFF) or reduced to
// a 1×1 placeholder. Without UOP support the extractor pulled "two
// pixels of hair" for clockwork scorpion / dragon wolf / etc. — what
// Marcin saw on screen.
//
// Each UOP entry is keyed by the lowercase virtual filename
// `build/animationlegacyframe/{body:06d}/{action:02d}.bin` hashed via
// the FileNameHasher (Bob Jenkins hashlittle2). The entry payload is
// zlib-compressed and decompresses to a single (body, action) bundle
// holding ALL FIVE direction × N frames concatenated.
//
// Format of the decompressed bundle (mirrors CUO `ReadUOPAnimationFrames`):
//   bytes 0..31           reserved / engine signature, skipped
//   u32       frameCount    total frames across all directions
//   u32       dataStart     offset of first frame's pixel block
//   per frame [16 bytes]:
//     u16     group         legacy anim group (informational)
//     u16     frameId       1-based; (frameId - 1) / framesPerDir = direction
//     u64     unknown       (often 0)
//     u32     pixelOffset   relative to bytes 0..31 + 8 + frameCount*16
//   per frame at (frame.position + frame.pixelOffset):
//     u16[256]  ARGB1555 palette (512 bytes)
//     i16       cx, cy, w, h
//     RLE       header u32 + pixels, terminator 0x7FFF7FFF
//
// `framesPerDir = round(maxFrameCount / 5)` (CUO formula). The frame
// list typically interleaves dir 0 first, then dir 1, etc., padded
// with zero-position placeholders for missing frames so the index
// math stays simple.
//
// Public surface:
//   `loadAnimUopFiles(srcDir)`           → opens every present
//                                          AnimationFrame*.uop, returns
//                                          a query helper
//   `helper.read(body, action, dir)`     → returns
//                                          [{ pixels, w, h, cx, cy }, ...]
//                                          or null when nothing's stored

import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hashFileName } from './hash.js';
import { readEntryContent } from './uop.js';

// AnimationFrame*.uop entries are keyed by Bob Jenkins hashlittle2
// (same as art/gump UOPs) — verified empirically against
// AnimationFrame4.uop's 426 entries. CUO's source has a separate
// `UOFileUop.CreateHash` function but it's a stale/dev-time variant;
// the released UOP files all use hashlittle2. Confirmed by hashing
// every plausible body/action filename and matching 124 hits in the
// body 700..800 / action 0..21 grid for AnimationFrame4 alone.
//
// Keeping the legacy CreateHash port below as an unused reference for
// anyone who finds an older UOP that needs it — flip the call in
// `loadAnimUopFiles.read` to `createHashLegacy` if so.
// eslint-disable-next-line no-unused-vars
function createHashLegacy(s) {
  let edi, esi, ebx, edx, ecx, eax;
  edi = esi = ebx = (s.length + 0xDEADBEEF) >>> 0;
  edx = ecx = eax = 0;
  let i = 0;
  for (; i + 12 < s.length; i += 12) {
    edi = ((((s.charCodeAt(i + 7) << 24) | (s.charCodeAt(i + 6) << 16) | (s.charCodeAt(i + 5) << 8) | s.charCodeAt(i + 4)) >>> 0) + edi) >>> 0;
    esi = ((((s.charCodeAt(i + 11) << 24) | (s.charCodeAt(i + 10) << 16) | (s.charCodeAt(i + 9) << 8) | s.charCodeAt(i + 8)) >>> 0) + esi) >>> 0;
    edx = ((((s.charCodeAt(i + 3) << 24) | (s.charCodeAt(i + 2) << 16) | (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i)) >>> 0) - esi) >>> 0;
    edx = (((edx + ebx) >>> 0) ^ ((esi >>> 28) | ((esi << 4) >>> 0))) >>> 0;
    esi = (esi + edi) >>> 0;
    edi = (((edi - edx) >>> 0) ^ ((edx >>> 26) | ((edx << 6) >>> 0))) >>> 0;
    edx = (edx + esi) >>> 0;
    esi = (((esi - edi) >>> 0) ^ ((edi >>> 24) | ((edi << 8) >>> 0))) >>> 0;
    edi = (edi + edx) >>> 0;
    ebx = (((edx - esi) >>> 0) ^ ((esi >>> 16) | ((esi << 16) >>> 0))) >>> 0;
    esi = (esi + edi) >>> 0;
    edi = (((edi - ebx) >>> 0) ^ ((ebx >>> 13) | ((ebx << 19) >>> 0))) >>> 0;
    ebx = (ebx + esi) >>> 0;
    esi = (((esi - edi) >>> 0) ^ ((edi >>> 28) | ((edi << 4) >>> 0))) >>> 0;
    edi = (edi + ebx) >>> 0;
  }
  const rest = s.length - i;
  if (rest > 0) {
    if (rest >= 12) esi = (esi + ((s.charCodeAt(i + 11) << 24) >>> 0)) >>> 0;
    if (rest >= 11) esi = (esi + ((s.charCodeAt(i + 10) << 16) >>> 0)) >>> 0;
    if (rest >= 10) esi = (esi + ((s.charCodeAt(i +  9) <<  8) >>> 0)) >>> 0;
    if (rest >=  9) esi = (esi +  s.charCodeAt(i +  8)) >>> 0;
    if (rest >=  8) edi = (edi + ((s.charCodeAt(i +  7) << 24) >>> 0)) >>> 0;
    if (rest >=  7) edi = (edi + ((s.charCodeAt(i +  6) << 16) >>> 0)) >>> 0;
    if (rest >=  6) edi = (edi + ((s.charCodeAt(i +  5) <<  8) >>> 0)) >>> 0;
    if (rest >=  5) edi = (edi +  s.charCodeAt(i +  4)) >>> 0;
    if (rest >=  4) ebx = (ebx + ((s.charCodeAt(i +  3) << 24) >>> 0)) >>> 0;
    if (rest >=  3) ebx = (ebx + ((s.charCodeAt(i +  2) << 16) >>> 0)) >>> 0;
    if (rest >=  2) ebx = (ebx + ((s.charCodeAt(i +  1) <<  8) >>> 0)) >>> 0;
    if (rest >=  1) ebx = (ebx +  s.charCodeAt(i)) >>> 0;
    esi = ((esi ^ edi) - (((edi >>> 18) | ((edi << 14) >>> 0)) >>> 0)) >>> 0;
    ecx = ((esi ^ ebx) - (((esi >>> 21) | ((esi << 11) >>> 0)) >>> 0)) >>> 0;
    edi = ((edi ^ ecx) - (((ecx >>>  7) | ((ecx << 25) >>> 0)) >>> 0)) >>> 0;
    esi = ((esi ^ edi) - (((edi >>> 16) | ((edi << 16) >>> 0)) >>> 0)) >>> 0;
    edx = ((esi ^ ecx) - (((esi >>> 28) | ((esi <<  4) >>> 0)) >>> 0)) >>> 0;
    edi = ((edi ^ edx) - (((edx >>> 18) | ((edx << 14) >>> 0)) >>> 0)) >>> 0;
    eax = ((esi ^ edi) - (((edi >>>  8) | ((edi << 24) >>> 0)) >>> 0)) >>> 0;
    return (BigInt(edi) << 32n) | BigInt(eax);
  }
  return (BigInt(edi) << 32n) | BigInt(eax);
}

const UOP_INDICES = [1, 2, 3, 4, 5, 6];

/**
 * Open every AnimationFrame*.uop the data folder ships, build a hash
 * table per file. Returns a `{ read, close }` API.
 */
export async function loadAnimUopFiles(srcDir) {
  const files = [];
  for (const i of UOP_INDICES) {
    const path = join(srcDir, `AnimationFrame${i}.uop`);
    if (!existsSync(path)) continue;
    try {
      const handle = await openUopForAnim(path);
      files.push({ index: i, ...handle });
    } catch (e) {
      console.warn(`[anim-uop] failed to open ${path}: ${e.message}`);
    }
  }
  if (!files.length) {
    return { read: () => null, close: () => Promise.resolve(), available: false };
  }
  return {
    available: true,
    read: async (body, action, dir, options = {}) => {
      // CUO maps body→file via bodyconv but if MUL is empty we don't
      // know which file to consult. The hash for `build/.../{body:06d}/
      // {action:02d}.bin` is the SAME across files (filename is the
      // same — the UOP archive boundary just bins entries by era).
      // Walk every open UOP; first hit wins.
      const hash = hashFileName(`build/animationlegacyframe/${pad6(body)}/${pad2(action)}.bin`);
      const key = hashKey(hash);
      for (const f of files) {
        const entry = f.byHash.get(key);
        if (!entry) continue;
        try {
          const decoded = await readEntryContent(f.fd, entry);
          if (!decoded) continue;
          const frames = decodeUopAnimEntry(decoded, dir, options);
          if (frames?.length) return frames;
        } catch (e) {
          console.warn(`[anim-uop] decode body=${body} action=${action} dir=${dir} failed: ${e.message}`);
        }
      }
      return null;
    },
    close: async () => {
      await Promise.all(files.map((f) => f.fd.close().catch(() => {})));
    },
  };
}

// ---- UOP container reader ------------------------------------------------

async function openUopForAnim(path) {
  const fd = await open(path, 'r');
  const stat = await fd.stat();
  const totalSize = stat.size;
  const headerBuf = Buffer.alloc(28);
  await fd.read(headerBuf, 0, 28, 0);
  const magic = headerBuf.readUInt32LE(0);
  if (magic !== 0x0050594D) {     // 'MYP\0'
    await fd.close();
    throw new Error(`not a UOP (magic=0x${magic.toString(16)})`);
  }
  let blockOffset = Number(headerBuf.readBigUInt64LE(12));
  /** @type {Map<string, UopEntry>} keyed by hashKey() string */
  const byHash = new Map();
  while (blockOffset !== 0 && blockOffset < totalSize) {
    const blkHeader = Buffer.alloc(12);
    await fd.read(blkHeader, 0, 12, blockOffset);
    const fileCount = blkHeader.readUInt32LE(0);
    const nextBlock = Number(blkHeader.readBigUInt64LE(4));
    const filesBuf = Buffer.alloc(fileCount * 34);
    await fd.read(filesBuf, 0, filesBuf.length, blockOffset + 12);
    let p = 0;
    for (let i = 0; i < fileCount; i++) {
      const dataOffset       = Number(filesBuf.readBigUInt64LE(p +  0));
      const headerLength     =        filesBuf.readUInt32LE(p +  8);
      const compressedSize   =        filesBuf.readUInt32LE(p + 12);
      const decompressedSize =        filesBuf.readUInt32LE(p + 16);
      const hash             =        filesBuf.readBigUInt64LE(p + 20);
      const compressionFlag  =        filesBuf.readUInt16LE(p + 32);
      p += 34;
      // Some entries have hash=0 / size=0 — empty slots; skip.
      if (compressedSize === 0) continue;
      byHash.set(hashKey(hash), {
        dataOffset, headerLength, compressedSize, decompressedSize, compressionFlag,
      });
    }
    blockOffset = nextBlock;
  }
  return { fd, byHash };
}

// ---- Entry decoder -------------------------------------------------------

/**
 * Decode a single decompressed entry into `[{ pixels, w, h, cx, cy }, ...]`
 * for the requested direction. Returns null on parse failure.
 *
 * @param {Buffer} buf
 * @param {number} requestedDir   0..4
 * @param {{ equipment?: boolean }} [options]
 */
export function decodeUopAnimEntry(buf, requestedDir, options = {}) {
  if (buf.length < 32 + 8) return null;
  let pos = 32;                                // skip engine signature
  const frameCount = buf.readUInt32LE(pos); pos += 4;
  const dataStart  = buf.readUInt32LE(pos); pos += 4;
  if (frameCount <= 0 || frameCount > 4096) return null;
  if (dataStart <= 0 || dataStart > buf.length) return null;

  // Frame metadata table.
  /** @type {{group:number,frameId:number,absPos:number,pixelOffset:number}[]} */
  const meta = [];
  // `dataStart` points at the metadata table. It is commonly 40, but some
  // client versions insert extra header bytes; reading from `pos` corrupts
  // group/frame ids and ultimately produces tiny or empty sprites.
  let metaPos = dataStart;
  for (let i = 0; i < frameCount; i++) {
    if (metaPos + 16 > buf.length) return null;
    const group       = buf.readUInt16LE(metaPos);
    const frameId     = buf.readUInt16LE(metaPos + 2);
    // 8 bytes "unknown"
    const pixelOffset = buf.readUInt32LE(metaPos + 12);
    meta.push({ group, frameId, absPos: metaPos, pixelOffset });
    metaPos += 16;
  }

  // CUO inserts placeholders for skipped frame IDs so direction math
  // stays linear. Mirror that behaviour: walk meta, fill gaps in the
  // 1..N frameId range with empty slots.
  /** @type {(typeof meta[number] | { absPos: 0, frameId: number, pixelOffset: 0, group: 0 })[]} */
  const expanded = [];
  let lastFrameId = 1;
  for (const f of meta) {
    while (f.frameId - lastFrameId > 1) {
      lastFrameId += 1;
      expanded.push({ absPos: 0, pixelOffset: 0, frameId: lastFrameId, group: 0 });
    }
    expanded.push(f);
    lastFrameId = f.frameId;
  }
  if (!expanded.length) return null;

  const maxFrameCount = expanded.length;
  const normalFramesPerDir = Math.max(1, Math.round(maxFrameCount / 5));
  const framesPerDir = options.equipment
    ? Math.max(10, normalFramesPerDir)
    : normalFramesPerDir;

  // Walk frames belonging to the requested direction. CUO: dir =
  // (frameId - 1) / framesPerDir; idx = (frameId - 1) % framesPerDir.
  const out = new Array(framesPerDir).fill(null);
  for (const f of expanded) {
    const dir = ((f.frameId - 1) / framesPerDir) | 0;
    if (dir < requestedDir) continue;
    if (dir > requestedDir) break;
    const idx = (f.frameId - 1) % framesPerDir;
    if (f.absPos === 0) {
      // missing frame — leave hole; downstream filters out null entries.
      continue;
    }
    const framePos = f.absPos + f.pixelOffset;
    if (framePos + 512 + 8 > buf.length) continue;
    out[idx] = decodeFramePixels(buf, framePos);
  }
  if (!out.some(Boolean)) return null;
  // Equipment must retain CUO's ten-frame minimum so body and equipped
  // overlays share frame indices. Other animation types can discard null
  // tail padding to keep manifests compact.
  if (!options.equipment) {
    while (out.length && !out[out.length - 1]) out.pop();
  }
  return out;
}

/** Decode a single frame's pixel block: palette + cx/cy/w/h + RLE. */
function decodeFramePixels(buf, p) {
  // 256-entry ARGB1555 palette.
  const palette = new Uint16Array(256);
  for (let i = 0; i < 256; i++) palette[i] = buf.readUInt16LE(p + i * 2);
  p += 512;
  const cx = buf.readInt16LE(p); p += 2;
  const cy = buf.readInt16LE(p); p += 2;
  const w  = buf.readInt16LE(p); p += 2;
  const h  = buf.readInt16LE(p); p += 2;
  if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null;
  const pixels = new Uint8Array(w * h * 4);
  while (p + 4 <= buf.length) {
    const header = buf.readUInt32LE(p); p += 4;
    if (header === 0x7FFF7FFF) break;
    const runLength = header & 0x0FFF;
    let x = (header >> 22) & 0x03FF;
    if (x & 0x200) x |= ~0x3FF;             // sign-extend 10-bit
    let y = (header >> 12) & 0x03FF;
    if (y & 0x200) y |= ~0x3FF;
    x += cx;
    y += cy + h;
    for (let i = 0; i < runLength; i++) {
      if (p + 1 > buf.length) break;
      const idx = buf.readUInt8(p); p++;
      const c = palette[idx];
      const px = x + i;
      if (px < 0 || px >= w || y < 0 || y >= h) continue;
      if (c === 0) continue;
      const r5 = (c >> 10) & 0x1f;
      const g5 = (c >>  5) & 0x1f;
      const b5 =  c        & 0x1f;
      const o = (y * w + px) * 4;
      pixels[o + 0] = (r5 << 3) | (r5 >> 2);
      pixels[o + 1] = (g5 << 3) | (g5 >> 2);
      pixels[o + 2] = (b5 << 3) | (b5 >> 2);
      pixels[o + 3] = 255;
    }
  }
  return { pixels, w, h, cx, cy };
}

// ---- helpers -------------------------------------------------------------

function pad6(n) { return String(n | 0).padStart(6, '0'); }
function pad2(n) { return String(n | 0).padStart(2, '0'); }
function hashKey(bigint) { return bigint.toString(16); }

/** @typedef {Object} UopEntry
 *  @property {number} dataOffset
 *  @property {number} headerLength
 *  @property {number} compressedSize
 *  @property {number} decompressedSize
 *  @property {number} compressionFlag
 */
