// Extract fonts.mul → fonts.png (single packed atlas) + fonts.json.
//
// fonts.mul ships 10 ASCII fonts (0..9). Font 0 is the primary UO game
// font. Each font has 224 glyphs (codes 0x20..0xFF — printable ASCII +
// extended latin) preceded by a 1-byte header.
//
// Per-glyph layout:
//   byte width
//   byte height
//   byte unknown (kerning / baseline shift, ignored)
//   ushort[width * height] pixels — ARGB1555 LE, MSB = alpha bit
//
// Mirrors ClassicUO.Assets/FontsLoader.cs ReadFonts.
//
// We pack every glyph from every font into a single PNG atlas using a
// shelf-pack algorithm (sort glyphs by height, place on rows). The JSON
// manifest holds per-font glyph metadata: char code → { x, y, w, h }.
// At runtime the client looks up glyphs and draws Pixi `Sprite`s per
// character — produces the canonical UO bitmap font instead of the
// JavaScript Consolas fallback that read like a debug overlay.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from './safe-sharp.js';

const FONT_COUNT  = 10;
const GLYPH_COUNT = 224;          // 0x20..0xFF

export async function extractFonts(srcDir, outDir) {
  const buf = readFileSync(join(srcDir, 'fonts.mul'));

  /** Per-font array of glyph entries (or null when the glyph is empty). */
  const fonts = [];
  let off = 0;
  for (let f = 0; f < FONT_COUNT; f++) {
    /* const header = */ buf.readUInt8(off++);
    /** @type {Array<{w:number, h:number, pixels:Uint8ClampedArray} | null>} */
    const glyphs = new Array(GLYPH_COUNT);
    for (let g = 0; g < GLYPH_COUNT; g++) {
      if (off + 3 > buf.length) { glyphs[g] = null; continue; }
      const w = buf.readUInt8(off++);
      const h = buf.readUInt8(off++);
      /* const unk = */ buf.readUInt8(off++);
      const pixelCount = w * h;
      if (pixelCount === 0 || off + pixelCount * 2 > buf.length) {
        // No pixel data — empty glyph (spaces, control chars).
        glyphs[g] = { w, h, pixels: new Uint8ClampedArray(0) };
        continue;
      }
      const pixels = new Uint8ClampedArray(w * h * 4);    // RGBA
      for (let i = 0; i < pixelCount; i++) {
        const c = buf.readUInt16LE(off); off += 2;
        // UO fonts.mul stores 0RGB1555 — the alpha bit is NEVER set on
        // disk even for visible glyph pixels. ClassicUO derives alpha
        // from "pixel != 0" (any non-zero RGB = opaque). Our older code
        // tested `(c & 0x8000) !== 0` and marked every pixel
        // transparent, producing a fully-empty fonts.png — labels then
        // rendered zero glyphs ("spellbook has no text" / "all gump
        // labels missing").
        const a  = c !== 0 ? 255 : 0;
        const r5 = (c >> 10) & 0x1F;
        const g5 = (c >>  5) & 0x1F;
        const b5 =  c        & 0x1F;
        pixels[i * 4 + 0] = (r5 << 3) | (r5 >> 2);
        pixels[i * 4 + 1] = (g5 << 3) | (g5 >> 2);
        pixels[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
        pixels[i * 4 + 3] = a;
      }
      glyphs[g] = { w, h, pixels };
    }
    fonts.push(glyphs);
  }

  // Build atlas via shelf-pack: sort all glyphs descending by height,
  // place greedily on rows.
  const ATLAS_W = 512;
  /** Pack entries we'll iterate sorted. */
  const flat = [];
  for (let f = 0; f < FONT_COUNT; f++) {
    for (let g = 0; g < GLYPH_COUNT; g++) {
      const e = fonts[f][g];
      if (!e || !e.pixels || e.pixels.length === 0) continue;
      flat.push({ font: f, code: 0x20 + g, w: e.w, h: e.h, pixels: e.pixels });
    }
  }
  // Sort tallest-first for better shelf utilisation.
  flat.sort((a, b) => b.h - a.h);
  let shelfX = 0, shelfY = 0, shelfH = 0;
  for (const e of flat) {
    if (shelfX + e.w + 1 > ATLAS_W) {
      shelfX = 0;
      shelfY += shelfH + 1;
      shelfH = 0;
    }
    e.x = shelfX;
    e.y = shelfY;
    shelfX += e.w + 1;
    if (e.h > shelfH) shelfH = e.h;
  }
  const ATLAS_H = shelfY + shelfH + 1;

  // Compose RGBA atlas buffer.
  const atlas = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
  for (const e of flat) {
    for (let yy = 0; yy < e.h; yy++) {
      for (let xx = 0; xx < e.w; xx++) {
        const srcOff = (yy * e.w + xx) * 4;
        const dstOff = ((e.y + yy) * ATLAS_W + (e.x + xx)) * 4;
        atlas[dstOff + 0] = e.pixels[srcOff + 0];
        atlas[dstOff + 1] = e.pixels[srcOff + 1];
        atlas[dstOff + 2] = e.pixels[srcOff + 2];
        atlas[dstOff + 3] = e.pixels[srcOff + 3];
      }
    }
  }

  await sharp(atlas, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(join(outDir, 'fonts.png'));

  // Manifest: per font → per char → { x, y, w, h }.
  const manifest = {
    atlasW: ATLAS_W,
    atlasH: ATLAS_H,
    fontCount: FONT_COUNT,
    fonts: [],
  };
  for (let f = 0; f < FONT_COUNT; f++) {
    /** @type {Record<number, {x:number, y:number, w:number, h:number}>} */
    const glyphs = {};
    let maxH = 0;
    for (let g = 0; g < GLYPH_COUNT; g++) {
      const code = 0x20 + g;
      const e = flat.find((q) => q.font === f && q.code === code);
      if (e) {
        glyphs[code] = { x: e.x, y: e.y, w: e.w, h: e.h };
        if (e.h > maxH) maxH = e.h;
      } else {
        // Empty glyph (space + control) — store width-only metadata so
        // the renderer can advance the cursor. Most fonts use 4-px space.
        const src = fonts[f][g];
        glyphs[code] = { x: 0, y: 0, w: src?.w ?? 0, h: src?.h ?? 0 };
      }
    }
    manifest.fonts.push({ index: f, lineHeight: maxH, glyphs });
  }
  writeFileSync(join(outDir, 'fonts.json'), JSON.stringify(manifest));
  return { count: flat.length, fonts: FONT_COUNT, atlasW: ATLAS_W, atlasH: ATLAS_H };
}
