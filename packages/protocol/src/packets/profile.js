// 0xB8 ProfileReq / ProfileResp — character profile read/write.
//
// Client sends 0xB8 to request a profile (read), or to commit a new
// profile body (write — only valid for the player's own character).
//   Layout (read request):
//     u8  0xB8
//     u16 length              (~8)
//     u8  command   (0 = view request)
//     u32 targetSerial
//     u8  unused (often 0)
//
//   Layout (write request):
//     u8  0xB8
//     u16 length
//     u8  command   (1 = update)
//     u32 targetSerial
//     u16 commandType (0)
//     u16 charsCount
//     [charsCount × u16] new body, big-endian unicode
//
// Server response is the SAME 0xB8 with a new layout:
//     u8  0xB8
//     u16 length
//     u32 serial
//     u8  zero
//     [ASCII null-terminated header]   ("Profile of <name>")
//     [unicode-BE null-terminated title]
//     [unicode-BE null-terminated body]
//
// We implement the read flow end-to-end and serialise an empty title +
// the stored body for the write flow.

import { PacketWriter } from '../buffer.js';

/** Read either a view request (cmd=0) or update request (cmd=1). */
export function readProfileRequest(pkt) {
  if (pkt[0] !== 0xB8) throw new Error('not a 0xB8 profile packet');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  /* const len = */ dv.getUint16(1);
  const cmd = dv.getUint8(3);
  const target = dv.getUint32(4);
  if (cmd === 0) return { kind: 'view', target };
  if (cmd === 1) {
    /* const cmdType = */ dv.getUint16(8);
    const chars = dv.getUint16(10);
    let body = '';
    for (let i = 0; i < chars; i++) {
      const o = 12 + i * 2;
      const c = (dv.getUint8(o) << 8) | dv.getUint8(o + 1);
      if (c === 0) break;
      body += String.fromCharCode(c);
    }
    return { kind: 'update', target, body };
  }
  return { kind: 'unknown', target, cmd };
}

/**
 * Build a 0xB8 profile response. `header` is the ASCII title shown in
 * the gump's strip; `body` is the unicode profile text the player
 * writes.
 *
 * @param {{ serial:number, header:string, title?:string, body:string }} p
 */
export function profileResponse({ serial, header, title = '', body }) {
  const w = new PacketWriter(64);
  w.writeU8(0xB8);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial >>> 0);
  w.writeU8(0);
  // ASCII header + NUL.
  for (let i = 0; i < header.length; i++) w.writeU8(header.charCodeAt(i) & 0xff);
  w.writeU8(0);
  // Unicode-BE title + NUL terminator.
  for (let i = 0; i < title.length; i++) {
    const c = title.charCodeAt(i) & 0xffff;
    w.writeU8((c >> 8) & 0xff); w.writeU8(c & 0xff);
  }
  w.writeU8(0); w.writeU8(0);
  // Unicode-BE body + NUL terminator.
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i) & 0xffff;
    w.writeU8((c >> 8) & 0xff); w.writeU8(c & 0xff);
  }
  w.writeU8(0); w.writeU8(0);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
