// 0xC2 UnicodePrompt — server asks the client for a free-form string (e.g.
// "what will your guild name be?"). Client echoes back with the typed reply.
//
// Server → Client:
//   u8 0xC2, u16 length,
//   u32 senderSerial, u32 promptId,
//   u32 type (0 = message, 1 = prompt), 4 bytes language ("ENU\0"),
//   unicode-null text (UTF-16 big-endian).
//
// Client → Server (same opcode):
//   u8 0xC2, u16 length,
//   u32 senderSerial, u32 promptId, u32 cancelled (0=ok, 1=cancel),
//   4 bytes language, unicode-null text.

import { PacketWriter } from '../buffer.js';

/**
 * Build a 0xC2 prompt.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {number} p.promptId
 * @param {string} [p.text]
 * @param {string} [p.language]
 */
export function unicodePrompt({ serial, promptId, text = '', language = 'ENU' }) {
  const w = new PacketWriter(32);
  w.writeU8(0xC2);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial >>> 0);
  w.writeU32(promptId >>> 0);
  w.writeU32(1); // prompt (not message)
  const lang = (language + '\0\0\0\0').slice(0, 4);
  for (let i = 0; i < 4; i++) w.writeU8(lang.charCodeAt(i));
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) & 0xFFFF;
    w.writeU8((c >> 8) & 0xff);
    w.writeU8(c & 0xff);
  }
  w.writeU8(0); w.writeU8(0);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Parse a client 0xC2 prompt reply.
 *
 * @param {Uint8Array} pkt
 */
export function readUnicodePromptReply(pkt) {
  if (pkt[0] !== 0xC2) throw new Error('not a 0xC2 prompt');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const len = dv.getUint16(1);
  const serial = dv.getUint32(3);
  const promptId = dv.getUint32(7);
  const cancelled = dv.getUint32(11) === 0;
  let o = 19; // 3 + 4 + 4 + 4 + 4 language
  let text = '';
  while (o + 1 < len) {
    const hi = dv.getUint8(o); o += 1;
    const lo = dv.getUint8(o); o += 1;
    if (hi === 0 && lo === 0) break;
    text += String.fromCharCode((hi << 8) | lo);
  }
  return { serial, promptId, cancelled, text };
}
