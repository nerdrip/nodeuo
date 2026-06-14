// Extract art.mul (or artLegacyMUL.uop) → land + static atlases.
//
// art.mul has 0x10000 entries, indexed via artidx.mul (or per-file via UOP):
//   id 0      .. 0x3FFF : land tile, 44×44 diamond, ARGB1555 packed
//   id 0x4000 .. 0xFFFF : static item, variable size, ARGB1555 RLE
//
// Mirrors ClassicUO.Assets/ArtLoader.ReadLand and ReadStatic.
//
// In UOP form (artLegacyMUL.uop) every entry is a separate file named
// `build/artlegacymul/00000000.tga`, with a 8-byte legacy MUL header in
// front of the actual sprite. We strip that and treat the rest exactly
// like the .mul slice.
//
// Output:
//   land-atlas-NNN.png   2048×2048 RGBA atlases (one tile per 44×44 cell)
//   land-atlas.json      manifest mapping tileId → atlas page + (u, v)
//   static-atlas-NNN.png large RGBA atlases packed via shelf-pack
//   static-atlas.json    tileId → atlas page + (u, v, w, h)

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { openUopIndexed, readEntryContent } from './uop.js';

const TILE_W = 44;
const TILE_H = 44;
const ATLAS_W = 2048;
const ATLAS_H = 2048;
const TILES_PER_ROW = Math.floor(ATLAS_W / TILE_W); // 46
const TILES_PER_COL = Math.floor(ATLAS_H / TILE_H); // 46
const TILES_PER_PAGE = TILES_PER_ROW * TILES_PER_COL; // 2116

const LAND_COUNT = 0x4000;
const STATIC_COUNT = 0xC000; // 0x4000..0xFFFF

/** @param {string} src directory @param {string} outDir */
export async function extractArt(src, outDir) {
  const uopPath = join(src, 'artLegacyMUL.uop');
  const { fd, byIndex } = await openUopIndexed(
    uopPath,
    'build/artlegacymul/%08d.tga',
    LAND_COUNT + STATIC_COUNT,
  );
  try {
    await extractLand(fd, byIndex, outDir);
    await extractStatic(fd, byIndex, outDir);
  } finally {
    await fd.close();
  }
}

// ---------------------------------------------------------------------------
// LAND tiles

async function extractLand(fd, byIndex, outDir) {
  const maxPage = Math.ceil(LAND_COUNT / TILES_PER_PAGE);
  const manifest = { count: LAND_COUNT, pageCount: 0, tileW: TILE_W, tileH: TILE_H, tilesPerRow: TILES_PER_ROW, tiles: {} };
  let highestWritten = -1;

  for (let page = 0; page < maxPage; page++) {
    const buf = Buffer.alloc(ATLAS_W * ATLAS_H * 4); // RGBA
    const startId = page * TILES_PER_PAGE;
    const endId   = Math.min(LAND_COUNT, startId + TILES_PER_PAGE);
    let placed = 0;

    for (let id = startId; id < endId; id++) {
      const e = byIndex[id];
      if (!e || e.decompressedSize <= 8) continue;
      const content = await readEntryContent(fd, e);
      // No header strip — UOP-wrapped art entries are byte-identical
      // to the .mul slice they replace. CUO's ArtLoader reads them
      // straight (ArtLoader.cs:111-115). For LAND tiles that means
      // pixel data starts at offset 0; stripping 8 bytes ate the top
      // 4 pixels of every land tile and produced the visible "ground
      // texture noise" / pin-stripe artefacts.
      const pixels = readLandTile(content);
      const slot = id - startId;
      const cellX = (slot % TILES_PER_ROW) * TILE_W;
      const cellY = Math.floor(slot / TILES_PER_ROW) * TILE_H;
      blit(buf, ATLAS_W, ATLAS_H, pixels, TILE_W, TILE_H, cellX, cellY);
      manifest.tiles[id] = { page, u: cellX, v: cellY };
      placed++;
    }

    if (placed > 0) {
      await sharp(buf, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toFile(join(outDir, `land-atlas-${page.toString().padStart(2, '0')}.png`));
      highestWritten = page;
    }
  }
  // pageCount = highest index that was actually written + 1, so the
  // client preload loop never asks for a missing PNG.
  manifest.pageCount = highestWritten + 1;
  writeFileSync(join(outDir, 'land-atlas.json'), JSON.stringify(manifest));
}

/** Decode a land tile's diamond layout from the raw byte slice.
 *  Returns RGBA Uint8Array (44×44), transparent outside the diamond. */
function readLandTile(buf) {
  const out = new Uint8Array(TILE_W * TILE_H * 4);
  let off = 0;
  // Top half: 22 rows, widths 2..44 (stride 2), centered.
  for (let y = 0; y < 22; y++) {
    const width = (y * 2) + 2;
    const x0    = 22 - 1 - y;
    for (let i = 0; i < width; i++) {
      const c = buf.readUInt16LE(off); off += 2;
      writePx(out, x0 + i, y, c);
    }
  }
  // Bottom half: 22 rows, widths 44..2 (stride -2).
  for (let y = 22; y < 44; y++) {
    const width = (44 - y) * 2;
    const x0    = y - 22;
    for (let i = 0; i < width; i++) {
      const c = buf.readUInt16LE(off); off += 2;
      writePx(out, x0 + i, y, c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// STATIC items — variable size, RLE packed.

async function extractStatic(fd, byIndex, outDir) {
  // A simple shelf-pack: walk every static, group by max-height, pack
  // into 2048-wide rows. Outputs as many pages as needed.
  const sprites = [];
  for (let id = 0; id < STATIC_COUNT; id++) {
    const e = byIndex[LAND_COUNT + id];
    if (!e || e.decompressedSize <= 8) continue;
    const content = await readEntryContent(fd, e);
    // No 8-byte strip — see extractLand. For STATIC tiles the first
    // 8 bytes are the header (u32 flags + u16 width + u16 height) and
    // were being thrown away, so readStaticSprite was reading pixels
    // as the header → every wall in the atlas came out as a 14×24
    // garbage fragment, hence "no buildings visible" in the renderer.
    const sprite = readStaticSprite(content);
    if (!sprite) continue;
    sprite.id = LAND_COUNT + id;
    sprites.push(sprite);
  }

  // Shelf pack
  const pages = []; // [{ buf, used: { x, rowH } }]
  /** @type {Record<number, {page:number, u:number, v:number, w:number, h:number}>} */
  const tiles = {};

  for (const s of sprites) {
    let placed = false;
    for (let pi = 0; pi < pages.length; pi++) {
      const p = pages[pi];
      // Try current shelf
      const shelf = p.shelf;
      if (shelf.x + s.w <= ATLAS_W && s.h <= shelf.rowH) {
        blit(p.buf, ATLAS_W, ATLAS_H, s.pixels, s.w, s.h, shelf.x, shelf.y);
        tiles[s.id] = { page: pi, u: shelf.x, v: shelf.y, w: s.w, h: s.h };
        shelf.x += s.w;
        placed = true; break;
      }
      // Try a new shelf below.
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
      .toFile(join(outDir, `static-atlas-${i.toString().padStart(3, '0')}.png`));
  }

  writeFileSync(
    join(outDir, 'static-atlas.json'),
    JSON.stringify({ pageCount: pages.length, atlasW: ATLAS_W, atlasH: ATLAS_H, tiles }),
  );
}

/** Decode a single static-item RLE sprite. Returns { pixels: RGBA, w, h }. */
function readStaticSprite(buf) {
  if (buf.length < 8) return null;
  // u32 flags (skipped), u16 width, u16 height
  const w = buf.readUInt16LE(4);
  const h = buf.readUInt16LE(6);
  if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null;
  const lookup = new Array(h);
  for (let y = 0; y < h; y++) lookup[y] = buf.readUInt16LE(8 + y * 2);
  const dataBase = 8 + h * 2;

  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    let off = dataBase + lookup[y] * 2;
    let x = 0;
    for (;;) {
      if (off + 4 > buf.length) break;
      const xOffset = buf.readUInt16LE(off); off += 2;
      const run     = buf.readUInt16LE(off); off += 2;
      if (xOffset + run >= 2048 || run === 0) break;
      x += xOffset;
      for (let i = 0; i < run; i++) {
        if (off + 2 > buf.length) break;
        const c = buf.readUInt16LE(off); off += 2;
        if (x + i < w) writePx(pixels, x + i, y, c, w);
      }
      x += run;
    }
  }
  return { pixels, w, h };
}

// ---------------------------------------------------------------------------

/** ARGB1555 → write RGBA at (x,y) with a configurable stride. */
function writePx(buf, x, y, c, stride = TILE_W) {
  if (c === 0) return; // 0 = transparent, regardless of high bit
  const r5 = (c >> 10) & 0x1f;
  const g5 = (c >>  5) & 0x1f;
  const b5 =  c        & 0x1f;
  const o = (y * stride + x) * 4;
  buf[o + 0] = (r5 << 3) | (r5 >> 2);
  buf[o + 1] = (g5 << 3) | (g5 >> 2);
  buf[o + 2] = (b5 << 3) | (b5 >> 2);
  buf[o + 3] = 255;
}

/** Copy an RGBA tile into a larger RGBA atlas. */
function blit(dst, dstW, _dstH, src, srcW, srcH, dstX, dstY) {
  for (let y = 0; y < srcH; y++) {
    const srcOff = y * srcW * 4;
    const dstOff = ((dstY + y) * dstW + dstX) * 4;
    dst.set(src.subarray(srcOff, srcOff + srcW * 4), dstOff);
  }
}
