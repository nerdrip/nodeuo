// Container packets (server -> client).
//
// ServUO references: `Server/Network/Packets.cs`:
//   - `DisplayContainer` (0x24)
//   - `ContainerContent6017` / `ContainerContent` (0x3C)
//   - `ContainerContentUpdate6017` (0x25)
//
// All implementations use the SA+ (>= 6.0.1.7) variant with grid locations.
// Entries are 20 bytes each (0x3C) or 21 bytes (single update 0x25).

import { PacketWriter } from '../buffer.js';

/**
 * 0x24 DisplayContainer — tell the client to open a container gump.
 * Size: 9 bytes (SA+ variant includes a trailing u16 max-items slot count).
 *
 * @param {number} serial    container item serial
 * @param {number} gumpId    0x0003..0x00FE ish — classic backpack is 0x003C
 * @param {number} [maxItems=0x7D] typical backpack capacity; UO clients largely
 *                                 ignore this but it must be present for SA.
 */
export function displayContainer(serial, gumpId, maxItems = 0x7D) {
  const w = new PacketWriter(9);
  w.writeU8(0x24);
  w.writeU32(serial);
  w.writeU16(gumpId & 0xffff);
  w.writeU16(maxItems & 0xffff);
  return w.bytes();
}

/**
 * @typedef {Object} ContainerEntry
 * @property {number} serial
 * @property {number} itemId
 * @property {number} [amount]
 * @property {number} [gridX]
 * @property {number} [gridY]
 * @property {number} [gridLocation] // slot index, SA only
 * @property {number} [hue]
 */

/**
 * 0x3C ContainerContents — full listing of a container's children. Each
 * entry is 20 bytes (SA 6.0.1.7+ variant).
 *
 *   u8  0x3C
 *   u16 length
 *   u16 count
 *   repeat count:
 *     u32 serial
 *     u16 itemId
 *     u8  itemIdOffset (0)
 *     u16 amount
 *     u16 gridX
 *     u16 gridY
 *     u8  gridLocation
 *     u32 containerSerial
 *     u16 hue
 *
 * @param {number} containerSerial
 * @param {Iterable<ContainerEntry>} entries
 */
export function containerContents(containerSerial, entries) {
  const list = Array.from(entries);
  const size = 5 + 20 * list.length;
  const w = new PacketWriter(size);
  w.writeU8(0x3C);
  w.writeU16(size);
  w.writeU16(list.length);
  for (const e of list) {
    w.writeU32(e.serial);
    w.writeU16(e.itemId & 0xffff);
    w.writeU8(0);
    w.writeU16((e.amount ?? 1) & 0xffff);
    w.writeU16((e.gridX ?? 0) & 0xffff);
    w.writeU16((e.gridY ?? 0) & 0xffff);
    w.writeU8((e.gridLocation ?? 0) & 0xff);
    w.writeU32(containerSerial);
    w.writeU16((e.hue ?? 0) & 0xffff);
  }
  return w.bytes();
}

/**
 * 0x25 ContainerContentUpdate (SA 6017 variant) — 21 bytes, appends/updates a
 * single item in an already-displayed container.
 *
 * @param {ContainerEntry} entry
 * @param {number} containerSerial
 */
export function containerContentUpdate(entry, containerSerial) {
  const w = new PacketWriter(21);
  w.writeU8(0x25);
  w.writeU32(entry.serial);
  w.writeU16(entry.itemId & 0xffff);
  w.writeU8(0);
  w.writeU16((entry.amount ?? 1) & 0xffff);
  w.writeU16((entry.gridX ?? 0) & 0xffff);
  w.writeU16((entry.gridY ?? 0) & 0xffff);
  w.writeU8((entry.gridLocation ?? 0) & 0xff);
  w.writeU32(containerSerial);
  w.writeU16((entry.hue ?? 0) & 0xffff);
  return w.bytes();
}
