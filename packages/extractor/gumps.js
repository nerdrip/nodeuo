// Extract gumpart.mul / gumpartLegacyMUL.uop → atlas PNGs + manifest.
//
// Layout for gump sprites: same RLE format as static art, but with
// `.extra` (the UOP "extra" field) carrying width × height as
// (extra >> 16, extra & 0xFFFF). Mirrors ClassicUO.Assets/GumpsLoader.cs.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { openUopIndexed, readEntryContent } from './uop.js';

const GUMP_COUNT = 0x10000; // 65536 ids reserved
const ATLAS_W = 2048;
const ATLAS_H = 2048;

export async function extractGumps(src, outDir) {
  const uopPath = join(src, 'gumpartLegacyMUL.uop');
  const { fd, byIndex } = await openUopIndexed(
    uopPath,
    'build/gumpartlegacymul/%08d.tga',
    GUMP_COUNT,
  );
  try {
    const sprites = [];
    for (let id = 0; id < GUMP_COUNT; id++) {
      const e = byIndex[id];
      if (!e || e.decompressedSize <= 8) continue;
      const content = await readEntryContent(fd, e);
      // gumpartLegacyMUL.uop has an "extra" 8-byte prefix on every entry
      // carrying (u32 width, u32 height). The remaining bytes are the
      // standard MUL gump body. Mirrors CUO UOFileUop(..., hasExtra=true).
      if (content.length < 8) continue;
      const width  = content.readUInt32LE(0);
      const height = content.readUInt32LE(4);
      if (width < 1 || height < 1 || width > 2048 || height > 2048) continue;
      const sprite = readGumpSprite(content.subarray(8), width, height);
      if (!sprite) continue;
      sprite.id = id;
      sprites.push(sprite);
    }
    await packAtlases(sprites, outDir, 'gump');
  } finally {
    await fd.close();
  }
}

/**
 * Decode a gump sprite given the content (after the 8-byte extra header
 * has been stripped) and the width × height carried in `extra`.
 *
 * Layout (matches CUO ReadGump):
 *   u32 lookup[height]   — offsets in u32-words from the start of the
 *                          lookup table
 *   then per-row RLE pairs of `(u16 color, u16 run)`. Run is repeated
 *   `run` times in u16 BGR555 (color) — no transparent skip mid-row;
 *   transparent regions are runs of color=0.
 */
function readGumpSprite(buf, width, height) {
  const lookupBytes = height * 4;
  if (buf.length < lookupBytes) return null;
  const lookup = new Array(height);
  for (let y = 0; y < height; y++) lookup[y] = buf.readUInt32LE(y * 4);

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    let off = lookup[y] * 4;
    let x = 0;
    while (off + 4 <= buf.length && x < width) {
      const color = buf.readUInt16LE(off); off += 2;
      const run   = buf.readUInt16LE(off); off += 2;
      if (run === 0) break;
      for (let i = 0; i < run && (x + i) < width; i++) {
        writeRgba(pixels, width, x + i, y, color);
      }
      x += run;
    }
  }
  return { pixels, w: width, h: height };
}

async function packAtlases(sprites, outDir, prefix) {
  const pages = [];
  /** @type {Record<number, {page:number,u:number,v:number,w:number,h:number}>} */
  const tiles = {};
  for (const s of sprites) {
    let placed = false;
    for (let pi = 0; pi < pages.length; pi++) {
      const p = pages[pi];
      const shelf = p.shelf;
      if (shelf.x + s.w <= ATLAS_W && s.h <= shelf.rowH) {
        blit(p.buf, ATLAS_W, ATLAS_H, s.pixels, s.w, s.h, shelf.x, shelf.y);
        tiles[s.id] = { page: pi, u: shelf.x, v: shelf.y, w: s.w, h: s.h };
        shelf.x += s.w;
        placed = true; break;
      }
      const newY = shelf.y + shelf.rowH;
      if (newY + s.h <= ATLAS_H && s.w <= ATLAS_W) {
        p.shelf = { x: s.w, y: newY, rowH: s.h };
        blit(p.buf, ATLAS_W, ATLAS_H, s.pixels, s.w, s.h, 0, newY);
        tiles[s.id] = { page: pi, u: 0, v: newY, w: s.w, h: s.h };
        placed = true; break;
      }
    }
    if (!placed) {
      const buf = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
      blit(buf, ATLAS_W, ATLAS_H, s.pixels, s.w, s.h, 0, 0);
      tiles[s.id] = { page: pages.length, u: 0, v: 0, w: s.w, h: s.h };
      pages.push({ buf, shelf: { x: s.w, y: 0, rowH: s.h } });
    }
  }
  for (let i = 0; i < pages.length; i++) {
    await sharp(pages[i].buf, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, `${prefix}-atlas-${i.toString().padStart(3, '0')}.png`));
  }
  writeFileSync(
    join(outDir, `${prefix}-atlas.json`),
    JSON.stringify({ pageCount: pages.length, atlasW: ATLAS_W, atlasH: ATLAS_H, tiles }),
  );
}

function writeRgba(buf, stride, x, y, c) {
  if (c === 0) return;
  const r5 = (c >> 10) & 0x1f;
  const g5 = (c >>  5) & 0x1f;
  const b5 =  c        & 0x1f;
  const o = (y * stride + x) * 4;
  buf[o + 0] = (r5 << 3) | (r5 >> 2);
  buf[o + 1] = (g5 << 3) | (g5 >> 2);
  buf[o + 2] = (b5 << 3) | (b5 >> 2);
  buf[o + 3] = 255;
}

function blit(dst, dstW, _dstH, src, srcW, srcH, dstX, dstY) {
  for (let y = 0; y < srcH; y++) {
    const srcOff = y * srcW * 4;
    const dstOff = ((dstY + y) * dstW + dstX) * 4;
    dst.set(src.subarray(srcOff, srcOff + srcW * 4), dstOff);
  }
}
