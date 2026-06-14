// 0xBA Quest Arrow — shows a compass arrow on the player's UI pointing to a
// world coordinate. Set `active=false` to clear.
//
// Packet layout: u8 op, u8 active, u16 x, u16 y, [u32 serial] (legacy: 6 bytes; modern: 10)

import { PacketWriter } from '../buffer.js';

/**
 * @param {Object} p
 * @param {boolean} p.active
 * @param {number} p.x
 * @param {number} p.y
 * @param {number} [p.serial]   optional target serial (modern clients)
 */
export function questArrow({ active, x, y, serial }) {
  const w = new PacketWriter(10);
  w.writeU8(0xBA);
  w.writeU8(active ? 1 : 0);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  if (serial !== undefined) w.writeU32(serial >>> 0);
  return w.bytes();
}
