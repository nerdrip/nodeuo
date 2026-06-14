// 0x1B Login Confirm — fixes the player's serial, body, position, and the
// world's map dimensions in the client. ServUO: `LoginConfirm`.
//
// Layout (37 bytes):
//   u8 0x1B
//   u32 serial
//   u32 unknown (0)
//   u16 body
//   u16 x
//   u16 y
//   u16 z
//   u8 direction
//   u8 unknown (0)
//   u32 unknown (-1)
//   u16 unknown (0)
//   u16 unknown (0)
//   u16 mapWidth   (e.g. 6144 for post-ML Felucca)
//   u16 mapHeight  (e.g. 4096)
//   u16 unknown (0)
//   u32 unknown (0)

import { PacketWriter } from '../buffer.js';

/**
 * @param {object} p
 * @param {number} p.serial
 * @param {number} p.body
 * @param {number} p.x
 * @param {number} p.y
 * @param {number} p.z
 * @param {number} [p.direction]
 * @param {number} [p.mapWidth]
 * @param {number} [p.mapHeight]
 */
export function loginConfirm({ serial, body, x, y, z, direction = 0, mapWidth = 6144, mapHeight = 4096 }) {
  const w = new PacketWriter(37);
  w.writeU8(0x1B);
  w.writeU32(serial);
  w.writeU32(0);
  w.writeU16(body);
  w.writeU16(x);
  w.writeU16(y);
  w.writeI16(z);
  w.writeU8(direction & 0xff);
  w.writeU8(0);
  w.writeI32(-1);
  w.writeU16(0);
  w.writeU16(0);
  w.writeU16(mapWidth);
  w.writeU16(mapHeight);
  w.writeU16(0);
  w.writeU32(0);
  return w.bytes();
}
