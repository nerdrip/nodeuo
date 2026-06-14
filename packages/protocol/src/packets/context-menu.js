// Context menu packets (right-click in 7.0.x client).
//
// - 0xBF 0x14 ContextMenu (S->C): list of menu entries for a target.
// - 0xBF 0x15 ContextMenuRequest (C->S): client asks for a menu.
// - 0xBF 0x16 ContextMenuResponse (C->S): client clicked an entry.
//
// The format used by SA clients (0x14 version 2):
//   u16 subcmd 0x0014
//   u16 version = 2 (enhanced)
//   u32 targetSerial
//   u8 entryCount
//   entryCount × { u32 entryId? actually u16 returnId; u16 clilocOffset (cliloc - 3000000);
//                  u16 flags }
//
// ServUO: Server/Network/Packets.cs — `DisplayContextMenu`.
//
// We emit the v2 (enhanced) layout since 7.0.x+ uses it.

import { PacketWriter } from '../buffer.js';

/**
 * @typedef {Object} ContextEntry
 * @property {number} responseId   value echoed back in 0x15 response
 * @property {number} cliloc       cliloc number (usually 3006xxx)
 * @property {number} [flags]      bit1 = disabled, bit2 = arrow (submenu), bit4 = colored
 * @property {number} [color]      ARGB short (if flags & 0x20)
 */

/**
 * 0xBF 0x14 DisplayContextMenu.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {ContextEntry[]} p.entries
 */
export function displayContextMenu({ serial, entries }) {
  const w = new PacketWriter(16 + entries.length * 10);
  w.writeU8(0xBF);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU16(0x0014);
  w.writeU16(0x0002);           // enhanced version
  w.writeU32(serial >>> 0);
  w.writeU8(entries.length & 0xff);
  for (const e of entries) {
    w.writeU16(e.responseId & 0xFFFF);
    // Cliloc delta from 3000000; Razor enhanced clients accept either the raw
    // cliloc OR the delta. Use delta for maximum compat.
    const delta = (e.cliloc - 3000000) & 0xFFFF;
    w.writeU16(delta);
    w.writeU16((e.flags ?? 0) & 0xFFFF);
    if (((e.flags ?? 0) & 0x20) !== 0) {
      w.writeU16((e.color ?? 0xFFFF) & 0xFFFF);
    }
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Parse 0xBF 0x15 ContextMenuRequest from the client.
 * @param {Uint8Array} pkt
 */
export function readContextMenuRequest(pkt) {
  if (pkt.length < 9 || pkt[0] !== 0xBF) throw new Error('not a 0xBF packet');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const sub = dv.getUint16(3);
  if (sub !== 0x0015) throw new Error(`0xBF subcmd ${sub.toString(16)} is not 0x0015`);
  return { serial: dv.getUint32(5) };
}

/**
 * Parse 0xBF 0x16 ContextMenuResponse from the client.
 * @param {Uint8Array} pkt
 */
export function readContextMenuResponse(pkt) {
  if (pkt.length < 11 || pkt[0] !== 0xBF) throw new Error('not a 0xBF packet');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const sub = dv.getUint16(3);
  if (sub !== 0x0016) throw new Error(`0xBF subcmd ${sub.toString(16)} is not 0x0016`);
  return {
    serial: dv.getUint32(5),
    responseId: dv.getUint16(9),
  };
}
