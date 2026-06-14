// Book packets.
//
// 0x93 OpenBook (legacy, 99 bytes):
//   u8 0x93, u32 serial, u8 writable, u8 newflag, u16 pages,
//   60 ASCII title, 30 ASCII author.
//
// 0xD4 NewBook (variable, Unicode — used by modern clients):
//   u8 0xD4, u16 length, u32 serial, u8 writable, u8 newflag, u16 pages,
//   u16 titleLen, titleLen bytes ASCII (inc NUL), u16 authorLen, authorLen bytes ASCII (inc NUL).
//
// 0x66 BookPages (variable): send the actual page contents.
//   u8 0x66, u16 length, u32 serial, u16 pageCount,
//   per page: u16 pageNumber, u16 lineCount, per line: ASCIIZ.
//
// 0xD4 with pages=0 opens a writable blank book; client responds by sending
// 0x66 BookPages back with filled-in content.

import { PacketWriter } from '../buffer.js';

const utf8Decoder = new TextDecoder();

function writeAscii(w, s, maxLen) {
  const bytes = new TextEncoder().encode(String(s ?? ''));
  const n = Math.min(bytes.length, maxLen - 1);
  for (let i = 0; i < n; i++) w.writeU8(bytes[i]);
  for (let i = n; i < maxLen; i++) w.writeU8(0);
}

function decodeUtf8Field(bytes) {
  const nul = bytes.indexOf(0);
  return utf8Decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

/**
 * 0x93 OpenBook (legacy 99-byte fixed).
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {boolean} [p.writable]
 * @param {number} p.pages
 * @param {string} [p.title]
 * @param {string} [p.author]
 */
export function openBookLegacy({ serial, writable = false, pages, title = '', author = '' }) {
  const w = new PacketWriter(99);
  w.writeU8(0x93);
  w.writeU32(serial >>> 0);
  w.writeU8(writable ? 1 : 0);
  w.writeU8(1);                // "new" flag — modern format supported
  w.writeU16(pages & 0xFFFF);
  writeAscii(w, title, 60);
  writeAscii(w, author, 30);
  return w.bytes();
}

/**
 * 0xD4 OpenBook (Unicode variable).
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {boolean} [p.writable]
 * @param {number} p.pages
 * @param {string} [p.title]
 * @param {string} [p.author]
 */
export function openBookNew({ serial, writable = false, pages, title = '', author = '' }) {
  const w = new PacketWriter(32);
  w.writeU8(0xD4);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial >>> 0);
  w.writeU8(writable ? 1 : 0);
  w.writeU8(1);
  w.writeU16(pages & 0xFFFF);
  const titleBytes = new TextEncoder().encode(title);
  w.writeU16((titleBytes.length + 1) & 0xFFFF);
  for (const b of titleBytes) w.writeU8(b);
  w.writeU8(0);
  const authorBytes = new TextEncoder().encode(author);
  w.writeU16((authorBytes.length + 1) & 0xFFFF);
  for (const b of authorBytes) w.writeU8(b);
  w.writeU8(0);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * 0x66 BookPages — send the page contents.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {string[][]} p.pages  pages[i] = array of lines
 */
export function bookPages({ serial, pages }) {
  const w = new PacketWriter(128);
  w.writeU8(0x66);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial >>> 0);
  w.writeU16(pages.length & 0xFFFF);
  for (let i = 0; i < pages.length; i++) {
    const lines = pages[i];
    w.writeU16((i + 1) & 0xFFFF);
    w.writeU16(lines.length & 0xFFFF);
    for (const line of lines) {
      const bytes = new TextEncoder().encode(String(line ?? ''));
      for (const b of bytes) w.writeU8(b);
      w.writeU8(0);
    }
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Parse an incoming 0x66 BookPages (client submitted their writes).
 * @param {Uint8Array} pkt
 */
export function readBookPages(pkt) {
  if (pkt[0] !== 0x66) throw new Error('not a 0x66 book pages');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const serial = dv.getUint32(3);
  const pageCount = dv.getUint16(7);
  /** @type {string[][]} */
  const pages = [];
  let o = 9;
  for (let p = 0; p < pageCount; p++) {
    const _pageNum = dv.getUint16(o); o += 2; void _pageNum;
    const lineCount = dv.getUint16(o); o += 2;
    /** @type {string[]} */
    const lines = [];
    for (let l = 0; l < lineCount; l++) {
      let s = '';
      while (o < pkt.length) {
        const b = dv.getUint8(o); o += 1;
        if (b === 0) break;
        s += String.fromCharCode(b);
      }
      lines.push(s);
    }
    pages.push(lines);
  }
  return { serial, pages };
}

/**
 * Parse 0xD9 BookHeaderNew (title/author update from client).
 * @param {Uint8Array} pkt
 */
export function readBookHeader(pkt) {
  if (pkt[0] !== 0xD4) throw new Error('not a 0xD4 book header');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const serial = dv.getUint32(3);
  const writable = dv.getUint8(7) !== 0;
  const pages = dv.getUint16(9);
  let o = 11;
  const titleLen = dv.getUint16(o); o += 2;
  const title = decodeUtf8Field(pkt.subarray(o, o + titleLen));
  o += titleLen;
  const authorLen = dv.getUint16(o); o += 2;
  const author = decodeUtf8Field(pkt.subarray(o, o + authorLen));
  o += authorLen;
  return { serial, writable, pages, title, author };
}
