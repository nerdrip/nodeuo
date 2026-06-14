// Extract texmaps.mul → texmap-atlas-NN.png + texmap-atlas.json
//
// texmaps.mul holds the *stretched-land textures* — the 64×64 (or 128×128)
// per-terrain colour maps that ClassicUO warps onto a slope quad via
// `UltimaBatcher2D.DrawStretchedLand`. Without these, our client falls
// back to warping the 44×44 art-tile diamond which produces visible
// distortion on steep terrain. With proper texmaps every slope shows
// the canonical UO ground texture cleanly tiled across the parallelogram.
//
// File layout (mirrors ClassicUO.Assets/TexmapsLoader.cs):
//   texidx.mul    standard MUL idx — u32 offset, u32 length, u32 extra
//   texmaps.mul   variable-size entries:
//                   length 0x2000 (8192)  → 64×64  ARGB1555 (LE)
//                   length 0x8000 (32768) → 128×128 ARGB1555 (LE)
//   TexTerr.def   optional alias group: every id in `<group>` becomes
//                 an alias for the head index (see TexmapsLoader.Load).
//
// Output:
//   texmap-atlas-NN.png   2048×2048 RGBA pages (shelf-packed by height)
//   texmap-atlas.json     {
//                            pageCount, atlasW, atlasH,
//                            tiles: { <texId>: { page, u, v, w, h } }
//                          }
//
// Indexed by `tiledata.land[id].texId` — the asset-manager looks the
// stretched texture up at render time when a slope is detected.

import { open } from 'node:fs/promises';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ATLAS_W = 2048;
const ATLAS_H = 2048;
const MAX_TEXMAPS = 0x4000;     // CUO MAX_LAND_TEXTURES_DATA_INDEX_COUNT
const IDX_ENTRY = 12;            // u32 offset, u32 length, u32 extra

/**
 * @param {string} srcDir   path to UO data directory
 * @param {string} outDir   path to assets output directory
 */
export async function extractTexmaps(srcDir, outDir) {
  const idxPath = pickFile(srcDir, ['texidx.mul', 'TexIdx.mul']);
  const datPath = pickFile(srcDir, ['texmaps.mul', 'TexMaps.mul']);
  if (!idxPath || !datPath) {
    return { count: 0, pages: 0, missing: true };
  }

  const idxBuf = readFileSync(idxPath);
  const dat = await open(datPath, 'r');
  try {
    /** @type {{ pixels: Uint8Array, w: number, h: number, id: number }[]} */
    const sprites = [];
    /** @type {Map<number, number>} alias child id → canonical id (TexTerr.def) */
    const aliasMap = readTexTerr(srcDir);

    // First pass — load every UNIQUE entry as RGBA. Aliases share storage.
    /** @type {Map<number, { pixels: Uint8Array, w: number, h: number }>} */
    const cache = new Map();

    const total = Math.min(MAX_TEXMAPS, Math.floor(idxBuf.length / IDX_ENTRY));
    for (let id = 0; id < total; id++) {
      // Aliases: TexTerr.def says "id N is the same texture as M". We
      // resolve the alias chain to its canonical id, decode that one,
      // and re-emit the manifest entry under both ids.
      const canonical = aliasMap.get(id) ?? id;
      let entry = cache.get(canonical);
      if (entry === undefined) {
        const off = canonical * IDX_ENTRY;
        if (off + IDX_ENTRY > idxBuf.length) continue;
        const offset = idxBuf.readUInt32LE(off + 0);
        const length = idxBuf.readUInt32LE(off + 4);
        if (offset === 0xFFFFFFFF || length === 0) continue;
        // Length picks size: 0x2000 → 64², 0x8000 → 128².
        const size = length === 0x8000 ? 128 : 64;
        if (length !== size * size * 2) continue;
        const buf = Buffer.alloc(length);
        await dat.read(buf, 0, length, offset);
        const pixels = decodeARGB1555(buf, size);
        entry = { pixels, w: size, h: size };
        cache.set(canonical, entry);
      }
      sprites.push({ ...entry, id });
    }

    // Shelf-pack into atlas pages — sort by descending height for tighter packing.
    sprites.sort((a, b) => b.h - a.h);
    const pages = [];
    /** @type {Record<number, {page:number, u:number, v:number, w:number, h:number}>} */
    const tiles = {};
    for (const sp of sprites) {
      let placed = false;
      for (let pi = 0; pi < pages.length; pi++) {
        const p = pages[pi];
        const sh = p.shelf;
        if (sh.x + sp.w <= ATLAS_W && sp.h <= sh.rowH) {
          blit(p.buf, ATLAS_W, sp.pixels, sp.w, sp.h, sh.x, sh.y);
          tiles[sp.id] = { page: pi, u: sh.x, v: sh.y, w: sp.w, h: sp.h };
          sh.x += sp.w;
          placed = true; break;
        }
        const newY = sh.y + sh.rowH;
        if (newY + sp.h <= ATLAS_H && sp.w <= ATLAS_W) {
          p.shelf = { x: sp.w, y: newY, rowH: sp.h };
          blit(p.buf, ATLAS_W, sp.pixels, sp.w, sp.h, 0, newY);
          tiles[sp.id] = { page: pi, u: 0, v: newY, w: sp.w, h: sp.h };
          placed = true; break;
        }
      }
      if (!placed) {
        const buf = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
        blit(buf, ATLAS_W, sp.pixels, sp.w, sp.h, 0, 0);
        tiles[sp.id] = { page: pages.length, u: 0, v: 0, w: sp.w, h: sp.h };
        pages.push({ buf, shelf: { x: sp.w, y: 0, rowH: sp.h } });
      }
    }

    for (let i = 0; i < pages.length; i++) {
      await sharp(pages[i].buf, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toFile(join(outDir, `texmap-atlas-${String(i).padStart(2, '0')}.png`));
    }
    writeFileSync(
      join(outDir, 'texmap-atlas.json'),
      JSON.stringify({ pageCount: pages.length, atlasW: ATLAS_W, atlasH: ATLAS_H, tiles }),
    );
    return { count: cache.size, sprites: sprites.length, pages: pages.length };
  } finally {
    await dat.close();
  }
}

/** Decode an ARGB1555 LE block into RGBA Uint8Array (size×size). */
function decodeARGB1555(buf, size) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const c = buf.readUInt16LE(i * 2);
    if (c === 0) {
      // Texmaps have no transparency in CUO — they fill solidly. Keep
      // alpha=255 for any zero-pixel as black, mirroring HuesHelper
      // `Color16To32(...)` | 0xFF000000 (TexmapsLoader.cs:88).
      out[i * 4 + 3] = 255;
      continue;
    }
    const r5 = (c >> 10) & 0x1f;
    const g5 = (c >>  5) & 0x1f;
    const b5 =  c        & 0x1f;
    out[i * 4 + 0] = (r5 << 3) | (r5 >> 2);
    out[i * 4 + 1] = (g5 << 3) | (g5 >> 2);
    out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Parse TexTerr.def — `<head> {<g1> <g2> ...} <unused>` per line.
 *  Each `gN` becomes an alias for `head` (returns Map<gN, head>). */
function readTexTerr(srcDir) {
  const path = pickFile(srcDir, ['TexTerr.def', 'texterr.def']);
  const out = new Map();
  if (!path) return out;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const m = /^\s*(-?\d+)\s*\{([^}]*)\}/.exec(line);
    if (!m) continue;
    const head = parseInt(m[1], 10);
    if (head < 0) continue;
    for (const tok of m[2].split(/[\s,]+/)) {
      const id = parseInt(tok, 10);
      if (Number.isFinite(id) && id >= 0) out.set(id, head);
    }
  }
  return out;
}

function pickFile(dir, names) {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

function blit(dst, dstW, src, srcW, srcH, dstX, dstY) {
  for (let y = 0; y < srcH; y++) {
    const so = y * srcW * 4;
    const dox = ((dstY + y) * dstW + dstX) * 4;
    dst.set(src.subarray(so, so + srcW * 4), dox);
  }
}
