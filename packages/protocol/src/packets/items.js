// 0xF3 WorldItemSA (SA+ clients). Replaces legacy 0x1A for most object types.
// ServUO: Server/Network/Packets.cs `WorldItemSA`.
//
// Layout (24 bytes for dataType=0, which is all we currently emit):
//   u8  0xF3
//   u16 reserved (1)
//   u8  dataType   (0 = item, 2 = multi)
//   u32 serial
//   u16 itemId
//   u8  direction  (usually 0 for items, facing for corpses)
//   u16 amount
//   u16 amount2    (usually same)
//   u16 x
//   u16 y
//   i8  z
//   u8  light level
//   u16 hue
//   u8  flags      (0x20 = hidden, 0x80 = movable, etc.)

import { PacketWriter } from '../buffer.js';

/**
 * 0xF3 WorldItemSA — 26 bytes fixed.
 *
 * Canonical post-SA layout (matches ClassicUO `PacketHandlers.UpdateItemSA`):
 *   u8  op (0xF3)
 *   u16 unknown (always 0x0001)
 *   u8  dataType (0=item, 1=corpse, 2=multi)
 *   u32 serial
 *   u16 graphic
 *   u8  graphicIncrement
 *   u16 amount  (twice — both the same; ServUO writes amount in both)
 *   u16 amount2
 *   u16 x
 *   u16 y
 *   i8  z
 *   u8  direction
 *   u16 hue
 *   u8  flags    (0x20 = hidden, 0x80 = movable, etc.)
 *   u16 unknown2 (always 0)
 *
 * Earlier (bug 2026-05-05) we shipped a 24-byte variant that omitted
 * `graphicIncrement` and `unknown2`, then routed `direction` into the
 * slot CUO uses for `light`. The client's framer table had the
 * canonical size 26, so every WorldItemSA over-read the next packet
 * by 2 bytes, producing the resync warnings users saw immediately
 * after login (when ServUO bulk-pushes the visible-tile items).
 */
export function worldItemSA({ serial, itemId, amount = 1, x, y, z, direction = 0, hue = 0, flags = 0x20, dataType = 0, graphicInc = 0 }) {
  const w = new PacketWriter(26);
  w.writeU8(0xF3);
  w.writeU16(1);
  w.writeU8(dataType & 0xff);
  w.writeU32(serial >>> 0);
  w.writeU16(itemId & 0xffff);
  w.writeU8(graphicInc & 0xff);
  w.writeU16(amount & 0xffff);
  w.writeU16(amount & 0xffff);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  w.writeI8(z);
  w.writeU8(direction & 0xff);
  w.writeU16(hue & 0xffff);
  w.writeU8(flags & 0xff);
  w.writeU16(0);
  return w.bytes();
}

/**
 * 0x1D RemoveEntity — tell a client to remove a serial from its world view.
 */
export function removeEntity(serial) {
  const w = new PacketWriter(5);
  w.writeU8(0x1D);
  w.writeU32(serial);
  return w.bytes();
}
