// Extract UO mouse cursors → cursors-atlas.png + cursors.json.
//
// UO ships its cursors as STATIC ART entries at ids 0x205A..0x208E
// (pre-AOS block, the canonical 32 cursor sprites). Newer 2D clients
// also reference a parallel set at gump.mul ids 0x2053..0x2079 for the
// AOS theme — when present, those override the art versions one-to-one.
//
// Each cursor is small (16×16 to 32×32, ARGB1555 RLE in art.mul). We
// pack them into ONE 256×256 RGBA atlas with a name → {x,y,w,h,hotspotX,
// hotspotY} manifest so the client can blit them onto a 2D canvas
// (drag-cursor.js / target-cursor.js style) without parsing the giant
// static atlas page just to grab a 32×32 reticle.
//
// CUO `Renderer/Cursor.cs` cursor table (CursorList[era][index]):
//   index 0..7  = walking arrows (NW/N/NE/E/SE/S/SW/W)
//   index 8     = NEUTRAL target reticle (yellow ring + crosshair)
//   index 9     = HARMFUL target reticle (red)
//   index 10    = BENEFICIAL target reticle (green)
//   index 11    = TARGET-SELF (blue arrow on self)
//   index 12..15 = misc (loot, party, etc.)
//
// We emit name keys based on those slots so client code reads cleanly:
//   cursors.json["walk-n"], ["target-neutral"], etc.

import { writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import sharp from 'sharp';
import { openUopIndexed, readEntryContent } from './uop.js';

// Pre-AOS cursor IDs in art.mul (CUO `CursorList[0]`).
//
// Index meaning follows CUO `GameCursor._cursorData[war, idx]`:
//   idx 0..7 = walking arrows (NW..NE..E..)
//   idx 8    = drag/grab open-hand (UIManager.IsDragging)
//   idx 9    = default pointer arrow (over UI / static)
//   idx 10/11= unused / minor target variants
//   idx 12   = target crosshair (TargetManager.IsTargeting)
//   idx 13   = hourglass (IsLoading)
//   idx 14   = text/edit pointer
//   idx 15   = help (pen / scroll)
//
// Earlier passes mislabelled idx 8 as `target-neutral` and idx 12 as
// `hourglass`, so the in-game target prompt painted the drag sprite.
// Labels now match CUO semantics; cursor consumers (system-cursor.js)
// use these keys directly.
const ART_CURSORS = [
  ['walk-n',           0x206A],
  ['walk-ne',          0x206B],
  ['walk-e',           0x206C],
  ['walk-se',          0x206D],
  ['walk-s',           0x206E],
  ['walk-sw',          0x206F],
  ['walk-w',           0x2070],
  ['walk-nw',          0x2071],
  ['drag-grab',        0x2072],   // idx 8 — open-hand drag
  ['drag-grab2',       0x2073],   // idx 9 — unused arrow variant
  ['drag-grab3',       0x2074],   // idx 10
  ['drag-hold',        0x2075],   // idx 11 — drag carrying item
  ['target-neutral',   0x2076],   // idx 12 — yellow crosshair (target)
  ['hourglass',        0x2077],   // idx 13 — loading
  ['text-edit',        0x2078],   // idx 14 — text input cursor
  ['help',             0x2079],   // idx 15 — pen/scroll
];

// AOS variant in gump.mul (CUO `CursorList[1]`). Same slot order.
const GUMP_CURSORS = [
  ['walk-n',           0x2053],
  ['walk-ne',          0x2054],
  ['walk-e',           0x2055],
  ['walk-se',          0x2056],
  ['walk-s',           0x2057],
  ['walk-sw',          0x2058],
  ['walk-w',           0x2059],
  ['walk-nw',          0x205A],
  ['drag-grab',        0x205B],
  ['drag-grab2',       0x205C],
  ['drag-grab3',       0x205D],
  ['drag-hold',        0x205E],
  ['target-neutral',   0x205F],
  ['hourglass',        0x2060],
  ['text-edit',        0x2061],
  ['help',             0x2062],
];

const ATLAS_W = 256;
const ATLAS_H = 256;

/**
 * @param {string} src   UO data folder
 * @param {string} outDir
 */
export async function extractCursors(src, outDir) {
  const sprites = [];
  // Pull from art.mul first — these are always present in classic-era
  // installs. Later we layer the AOS gump set on top so anything in
  // both ranges takes the AOS variant.
  const artUop = join(src, 'artLegacyMUL.uop');
  await pullFromUop(artUop, 'build/artlegacymul/%08d.tga',
    ART_CURSORS.map(([k, id]) => [k, id + 0x4000]),  // statics offset
    sprites, decodeArtSprite);

  const gumpUop = join(src, 'gumpartLegacyMUL.uop');
  await pullFromUop(gumpUop, 'build/gumpartlegacymul/%08d.tga',
    GUMP_CURSORS,
    sprites, decodeGumpSprite,
    /* preferOver */ true);

  // Pack into one 256×256 RGBA atlas with simple shelf-packing. With
  // ~32 cursors at 32×32 max each, we always fit on one page.
  const atlas = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
  /** @type {Record<string, {x:number,y:number,w:number,h:number,hotspotX:number,hotspotY:number}>} */
  const manifest = {};
  let cx = 0, cy = 0, rowH = 0;
  for (const s of sprites) {
    if (cx + s.w > ATLAS_W) { cy += rowH; cx = 0; rowH = 0; }
    if (cy + s.h > ATLAS_H) {
      console.warn(`[cursors] atlas full — dropping ${s.name} (${s.w}×${s.h})`);
      continue;
    }
    blit(atlas, ATLAS_W, ATLAS_H, s.pixels, s.w, s.h, cx, cy);
    manifest[s.name] = { x: cx, y: cy, w: s.w, h: s.h,
                         hotspotX: s.w >> 1, hotspotY: s.h >> 1 };
    cx += s.w;
    if (s.h > rowH) rowH = s.h;
  }
  await sharp(atlas, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, 'cursors-atlas.png'));
  writeFileSync(join(outDir, 'cursors.json'), JSON.stringify({
    atlas: 'cursors-atlas.png',
    width: ATLAS_W, height: ATLAS_H,
    cursors: manifest,
  }, null, 2));
  return { count: Object.keys(manifest).length };
}

async function pullFromUop(uopPath, template, table, out, decoder, preferOver = false) {
  let fd, byIndex;
  try {
    const opened = await openUopIndexed(uopPath, template, 0xFFFF);
    fd = opened.fd; byIndex = opened.byIndex;
  } catch (e) {
    console.warn(`[cursors] skip ${basename(uopPath)} — ${e?.message ?? e}`);
    return;
  }
  try {
    for (const [name, id] of table) {
      const e = byIndex[id];
      if (!e || e.decompressedSize <= 8) continue;
      const content = await readEntryContent(fd, e);
      const sprite = decoder(content);
      if (!sprite) continue;
      sprite.name = name;
      // Replace existing entry if `preferOver` is set (AOS overrides art).
      const existingIdx = out.findIndex((s) => s.name === name);
      if (existingIdx >= 0) {
        if (preferOver) out[existingIdx] = sprite;
      } else {
        out.push(sprite);
      }
    }
  } finally {
    await fd.close();
  }
}

/** Decode an art.mul cursor — same RLE format as static items but
 *  starting with an 8-byte header (u32 flags + u16 width + u16 height). */
function decodeArtSprite(content) {
  if (content.length < 8) return null;
  // u32 flags [0..3], u16 width [4..5], u16 height [6..7].
  const w = content.readUInt16LE(4);
  const h = content.readUInt16LE(6);
  if (w < 1 || h < 1 || w > 256 || h > 256) return null;
  return readStaticRle(content.subarray(8), w, h);
}

/** Decode a gump.mul cursor — same RLE-rows format as gumps. */
function decodeGumpSprite(content) {
  if (content.length < 8) return null;
  const w = content.readUInt32LE(0);
  const h = content.readUInt32LE(4);
  if (w < 1 || h < 1 || w > 256 || h > 256) return null;
  return readGumpRle(content.subarray(8), w, h);
}

function readStaticRle(buf, w, h) {
  const lookupBytes = h * 2;
  if (buf.length < lookupBytes) return null;
  const lookup = new Array(h);
  for (let y = 0; y < h; y++) lookup[y] = buf.readUInt16LE(y * 2);
  const baseDataStart = lookupBytes;
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    let off = baseDataStart + lookup[y] * 2;
    let x = 0;
    while (off + 4 <= buf.length && x < w) {
      const skip = buf.readUInt16LE(off); off += 2;
      const run  = buf.readUInt16LE(off); off += 2;
      if (skip === 0 && run === 0) break;
      x += skip;
      for (let i = 0; i < run && (x + i) < w; i++) {
        const c = buf.readUInt16LE(off + i * 2);
        writeRgba(pixels, w, x + i, y, c);
      }
      off += run * 2;
      x += run;
    }
  }
  return { pixels, w, h };
}

function readGumpRle(buf, w, h) {
  const lookupBytes = h * 4;
  if (buf.length < lookupBytes) return null;
  const lookup = new Array(h);
  for (let y = 0; y < h; y++) lookup[y] = buf.readUInt32LE(y * 4);
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    let off = lookup[y] * 4;
    let x = 0;
    while (off + 4 <= buf.length && x < w) {
      const color = buf.readUInt16LE(off); off += 2;
      const run   = buf.readUInt16LE(off); off += 2;
      if (run === 0) break;
      for (let i = 0; i < run && (x + i) < w; i++) {
        writeRgba(pixels, w, x + i, y, color);
      }
      x += run;
    }
  }
  return { pixels, w, h };
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
