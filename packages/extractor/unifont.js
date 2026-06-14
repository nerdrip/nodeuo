// Extract unifont*.mul (CJK / extended glyph) files → unifont-{N}.png +
// unifont.json.
//
// CUO `FontsLoader.cs::Load` opens unifont0.mul..unifont19.mul (0 = primary
// extended Latin, 1 = Korean, 2 = Japanese, 3 = Chinese (simplified),
// 4 = Chinese (traditional), 5..19 = optional regional). Per-file format:
//   header: u32[0x10000] — lookup table, each entry is a byte offset
//           into the same file (or 0 = glyph not present).
//   per-glyph: i8 offsetX, i8 offsetY, u8 width, u8 height,
//              then `ceil(width / 8) * height` bytes of 1-bpp pixels
//              (MSB-first; each set bit = opaque white pixel).
//
// We pack every non-zero glyph from each file into a single shelf-packed
// RGBA atlas (one PNG per unifont). The JSON manifest records:
//   { fonts: [{ index, atlasW, atlasH, glyphs: { <code>: {x,y,w,h,ox,oy} } }] }
// The client picks unifont N for a given chat speech based on the
// language code shipped by 0xAE (UnicodeSpeech) or, when no hint is
// available, falls back to font 0 (extended Latin).
//
// Only files actually present on disk are extracted — most installs ship
// only 0..4. Output is small (each unifont ~300-600 KB PNG).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const MAX_UNIFONT = 20;
const GLYPH_COUNT = 0x10000;

export async function extractUnifont(srcDir, outDir) {
  const fonts = [];
  for (let i = 0; i < MAX_UNIFONT; i++) {
    const name = `unifont${i === 0 ? '' : i}.mul`;
    const path = join(srcDir, name);
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    if (buf.length < GLYPH_COUNT * 4) continue;

    // Walk lookup table → decode every glyph with non-zero offset.
    /** @type {Array<{code:number,w:number,h:number,ox:number,oy:number,pixels:Uint8ClampedArray}>} */
    const flat = [];
    for (let code = 0; code < GLYPH_COUNT; code++) {
      const lookup = buf.readInt32LE(code * 4);
      if (lookup <= 0 || lookup >= buf.length - 4) continue;
      const ox = buf.readInt8(lookup);
      const oy = buf.readInt8(lookup + 1);
      const w  = buf.readUInt8(lookup + 2);
      const h  = buf.readUInt8(lookup + 3);
      if (w <= 0 || h <= 0 || w > 64 || h > 64) continue;
      const stride = Math.floor((w - 1) / 8) + 1;
      const dataLen = stride * h;
      if (lookup + 4 + dataLen > buf.length) continue;

      // Decode 1-bpp MSB-first into RGBA (white-on-transparent).
      const pixels = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const byte = buf[lookup + 4 + y * stride + (x >> 3)];
          const bit  = (byte >> (7 - (x & 7))) & 1;
          if (bit) {
            const o = (y * w + x) * 4;
            pixels[o] = 255; pixels[o + 1] = 255; pixels[o + 2] = 255; pixels[o + 3] = 255;
          }
        }
      }
      flat.push({ code, w, h, ox, oy, pixels });
    }
    if (flat.length === 0) continue;

    // Shelf-pack into a 4096px-wide atlas (WebGL2 baseline texture
    // limit). Wider atlas → flatter aspect → atlas height fits in u16,
    // and the texture also samples cheaper on tile cache.
    const ATLAS_W = 4096;
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

    const atlas = Buffer.alloc(ATLAS_W * ATLAS_H * 4);
    for (const e of flat) {
      for (let yy = 0; yy < e.h; yy++) {
        for (let xx = 0; xx < e.w; xx++) {
          const so = (yy * e.w + xx) * 4;
          const dst = ((e.y + yy) * ATLAS_W + (e.x + xx)) * 4;
          atlas[dst]     = e.pixels[so];
          atlas[dst + 1] = e.pixels[so + 1];
          atlas[dst + 2] = e.pixels[so + 2];
          atlas[dst + 3] = e.pixels[so + 3];
        }
      }
    }

    const pngName = `unifont-${i}.png`;
    await sharp(atlas, { raw: { width: ATLAS_W, height: ATLAS_H, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(join(outDir, pngName));

    // Pack glyph metadata as a contiguous binary buffer (typed view
    // base64) — 16 bytes per glyph: u16 code + u16 x + u16 y + u8 w +
    // u8 h + i8 ox + i8 oy + 4-byte pad-to-align.
    let maxH = 0;
    const recCount = flat.length;
    const recBuf = Buffer.alloc(recCount * 12);
    for (let k = 0; k < recCount; k++) {
      const e = flat[k];
      const off = k * 12;
      recBuf.writeUInt16LE(e.code, off);
      recBuf.writeUInt16LE(e.x & 0xFFFF, off + 2);
      recBuf.writeUInt16LE(e.y & 0xFFFF, off + 4);
      recBuf.writeUInt8(e.w & 0xFF, off + 6);
      recBuf.writeUInt8(e.h & 0xFF, off + 7);
      recBuf.writeInt8(e.ox | 0, off + 8);
      recBuf.writeInt8(e.oy | 0, off + 9);
      // bytes 10-11 reserved (kerning / language hint, future)
      if (e.h > maxH) maxH = e.h;
    }

    const perFontJson = {
      index: i,
      file: pngName,
      atlasW: ATLAS_W,
      atlasH: ATLAS_H,
      lineHeight: maxH,
      glyphCount: recCount,
      // base64-encoded record buffer; decoder unpacks in the client.
      records: recBuf.toString('base64'),
    };
    writeFileSync(join(outDir, `unifont-${i}.json`), JSON.stringify(perFontJson));

    fonts.push({
      index: i,
      file: pngName,
      manifest: `unifont-${i}.json`,
      atlasW: ATLAS_W,
      atlasH: ATLAS_H,
      lineHeight: maxH,
      glyphCount: recCount,
    });
  }

  if (fonts.length === 0) return { skipped: true };
  // Index manifest stays tiny (~1 KB) — names per-font JSON the client
  // lazy-loads only for the language code it actually needs.
  writeFileSync(join(outDir, 'unifont.json'), JSON.stringify({
    fontCount: fonts.length,
    fonts,
  }));
  return { count: fonts.length, total: fonts.reduce((a, f) => a + f.glyphCount, 0) };
}
