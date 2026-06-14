// 0xDD DisplayGumpPacked — zlib-compressed variant of 0xB0.
//
// Layout matches ServUO's `DisplayGumpPacked.cs`:
//   u8  0xDD
//   u16 length
//   u32 mobileSerial
//   u32 gumpId
//   u32 x
//   u32 y
//   u32 compressedLayoutSize  (raw zlib bytes + 4 prefix; matches ServUO quirk)
//   u32 decompressedLayoutSize (in bytes, includes trailing NUL)
//   bytes layoutZlib
//   u32 stringCount
//   u32 compressedStringsSize
//   u32 decompressedStringsSize
//   bytes stringsZlib
//
// The strings block, before compression, matches ServUO:
//   for each string:
//     u16 charCount
//     char16BE[charCount]
//
// Lives server-side because `node:zlib` is not available in the browser
// bundle. Client-side decoding (when added) will use DecompressionStream.

import zlib from 'node:zlib';
import { PacketWriter } from '@uo/protocol';

/**
 * @param {{
 *   serial: number,
 *   gumpId: number,
 *   x?: number,
 *   y?: number,
 *   layout: string,
 *   texts?: string[],
 * }} p
 * @returns {Uint8Array}
 */
export function displayGumpPacked({ serial, gumpId, x = 0, y = 0, layout, texts = [] }) {
  // Layout: ASCII bytes + trailing NUL, then zlib-deflate.
  const layoutRaw = Buffer.from(layout + '\0', 'binary');
  const layoutZ = zlib.deflateSync(layoutRaw);

  // Strings: per-string { u16 chars, char16BE[chars] }. The string count
  // itself is written outside the packed block, just like ServUO.
  let stringsByteLen = 0;
  for (const rawText of texts) {
    const t = rawText == null ? '' : String(rawText);
    if (t.length > 0xffff) throw new RangeError('packed gump text line exceeds u16 char count');
    stringsByteLen += 2 + t.length * 2;
  }
  const stringsRaw = Buffer.alloc(stringsByteLen);
  let so = 0;
  for (const rawText of texts) {
    const t = rawText == null ? '' : String(rawText);
    stringsRaw.writeUInt16BE(t.length >>> 0, so); so += 2;
    for (let i = 0; i < t.length; i++) {
      stringsRaw.writeUInt16BE(t.charCodeAt(i) & 0xFFFF, so);
      so += 2;
    }
  }
  const stringsZ = zlib.deflateSync(stringsRaw);

  const w = new PacketWriter(64 + layoutZ.length + stringsZ.length);
  w.writeU8(0xDD);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial >>> 0);
  w.writeU32(gumpId >>> 0);
  w.writeU32(x >>> 0);
  w.writeU32(y >>> 0);
  // ServUO writes (compressedLength + 4) into the "compressed length" field,
  // because the field historically described the compressed *block* including
  // its own decompressed-length prefix. ClassicUO mirrors this expectation.
  w.writeU32((layoutZ.length + 4) >>> 0);
  w.writeU32(layoutRaw.length >>> 0);
  for (const b of layoutZ) w.writeU8(b);

  w.writeU32(texts.length >>> 0);
  w.writeU32((stringsZ.length + 4) >>> 0);
  w.writeU32(stringsRaw.length >>> 0);
  for (const b of stringsZ) w.writeU8(b);

  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Round-trip helper used by tests: parses a 0xDD packet back into its
 * components by reversing the wire format and inflating both blocks.
 *
 * @param {Uint8Array} pkt
 */
export function readGumpPacked(pkt) {
  if (pkt[0] !== 0xDD) throw new Error('not a 0xDD packet');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  let o = 1;
  const len = dv.getUint16(o); o += 2; void len;
  const serial = dv.getUint32(o); o += 4;
  const gumpId = dv.getUint32(o); o += 4;
  const x = dv.getUint32(o); o += 4;
  const y = dv.getUint32(o); o += 4;
  const layoutCompField = dv.getUint32(o); o += 4;
  const layoutDecompSize = dv.getUint32(o); o += 4;
  const layoutZLen = layoutCompField - 4;
  const layoutZ = pkt.subarray(o, o + layoutZLen);
  o += layoutZLen;
  const layoutRaw = zlib.inflateSync(Buffer.from(layoutZ));
  if (layoutRaw.length !== layoutDecompSize) {
    throw new Error(`layout decompressed size mismatch: ${layoutRaw.length} vs ${layoutDecompSize}`);
  }
  const layout = layoutRaw.toString('binary').replace(/\0$/, '');

  const stringCount = dv.getUint32(o); o += 4;
  const stringsCompField = dv.getUint32(o); o += 4;
  const stringsDecompSize = dv.getUint32(o); o += 4;
  const stringsZLen = stringsCompField - 4;
  const stringsZ = pkt.subarray(o, o + stringsZLen);
  o += stringsZLen;
  const stringsRaw = zlib.inflateSync(Buffer.from(stringsZ));
  if (stringsRaw.length !== stringsDecompSize) {
    throw new Error(`strings decompressed size mismatch: ${stringsRaw.length} vs ${stringsDecompSize}`);
  }
  const texts = [];
  let so = 0;
  for (let i = 0; i < stringCount; i++) {
    const chars = stringsRaw.readUInt16BE(so); so += 2;
    let s = '';
    for (let j = 0; j < chars; j++) {
      s += String.fromCharCode(stringsRaw.readUInt16BE(so));
      so += 2;
    }
    texts.push(s);
  }
  return { serial, gumpId, x, y, layout, texts };
}

/** Threshold (uncompressed layout bytes) above which we promote 0xB0 → 0xDD. */
export const PACKED_GUMP_THRESHOLD = 2048;
