// Object properties (tooltips) — ServUO `OPLInfo` / `ObjectPropertyList`.
//
//   0xDC  OPLInfo             — 9 bytes fixed  : op u32 serial u32 hash
//                                (tells the client: "here's the latest
//                                 tooltip hash for this entity — if you don't
//                                 have a matching OPL cached, ask me for it")
//   0xD6  ObjectProperties    — variable-length: full property list
//
// 0xD6 layout:
//   u8 op, u16 len,
//   u16 flag = 0x0001, u32 serial, u16 unk = 0x0000, u32 hash,
//   [ u32 cliloc, u16 argsLenBytes, UTF-16LE args ] *,
//   u32 terminator = 0x00000000
//
// Yes, the args in 0xD6 are little-endian UTF-16 (unlike most UO strings).

import { PacketWriter } from '../buffer.js';

/**
 * 0xDC — 9 bytes, tells client the current hash so it can skip querying.
 *
 * @param {number} serial
 * @param {number} hash
 */
export function oplInfo(serial, hash) {
  const w = new PacketWriter(9);
  w.writeU8(0xDC);
  w.writeU32(serial >>> 0);
  w.writeU32(hash >>> 0);
  return w.bytes();
}

/**
 * 0xD6 ObjectProperties.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {number} p.hash
 * @param {Array<{cliloc:number, args?:string}>} p.entries
 */
export function objectProperties({ serial, hash, entries }) {
  const w = new PacketWriter(128);
  w.writeU8(0xD6);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU16(0x0001);
  w.writeU32(serial >>> 0);
  w.writeU16(0x0000);
  w.writeU32(hash >>> 0);
  for (const e of entries) {
    w.writeU32(e.cliloc >>> 0);
    const args = e.args ?? '';
    const bytesLen = args.length * 2;
    w.writeU16(bytesLen);
    for (let i = 0; i < args.length; i++) {
      const c = args.charCodeAt(i) & 0xffff;
      // UTF-16 little-endian (note: unique to this packet)
      w.writeU8(c & 0xff);
      w.writeU8((c >> 8) & 0xff);
    }
  }
  w.writeU32(0x00000000);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * 0xD6 query from the client — the client received an OPL hash via 0xDC
 * (or via 0xF3 world item) and now asks for the full list.
 *
 * Packet format (variable length):
 *   u8 0xD6, u16 len, u32[] serials to query
 */
export function readOPLRequest(pkt) {
  if (pkt[0] !== 0xD6) throw new Error('not 0xD6');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const len = dv.getUint16(1);
  const serials = [];
  for (let o = 3; o + 4 <= len; o += 4) {
    serials.push(dv.getUint32(o));
  }
  return { serials };
}

/**
 * Trivial non-cryptographic hash used to tag OPL revisions. ServUO uses a
 * custom Jenkins-like mix; for client-compat purposes any value that changes
 * when contents change is acceptable.
 *
 * @param {Array<{cliloc:number, args?:string}>} entries
 */
export function computeOPLHash(entries) {
  let h = 0x811c9dc5 >>> 0;
  for (const e of entries) {
    h = ((h ^ e.cliloc) * 0x01000193) >>> 0;
    if (e.args) {
      for (let i = 0; i < e.args.length; i++) {
        h = ((h ^ e.args.charCodeAt(i)) * 0x01000193) >>> 0;
      }
    }
  }
  return h >>> 0;
}
