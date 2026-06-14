// Mobile packets — 0x20 MobileUpdate, 0x77 MobileMoving, 0x78 MobileIncoming,
// 0x11 MobileStatus, 0x17 HealthbarPoison, 0x22 MovementAck.
//
// ServUO references: Server/Network/Packets.cs — `MobileUpdate`, `MobileMoving`,
// `MobileIncoming`, `MobileStatus`, `MovementAck`.

import { PacketWriter } from '../buffer.js';

/**
 * 0x20 MobileUpdate — refreshes the player's own mobile. 19 bytes.
 */
export function mobileUpdate({ serial, body, hue = 0, flags = 0, x, y, z, direction = 0 }) {
  const w = new PacketWriter(19);
  w.writeU8(0x20);
  w.writeU32(serial);
  w.writeU16(body);
  w.writeU8(0);
  w.writeU16(hue);
  w.writeU8(flags & 0xff);
  w.writeU16(x);
  w.writeU16(y);
  w.writeU16(0);
  w.writeU8(direction & 0xff);
  w.writeI8(z);
  return w.bytes();
}

/**
 * 0x77 MobileMoving — updates another mobile's position/direction. 17 bytes.
 */
export function mobileMoving({ serial, body, x, y, z, direction = 0, hue = 0, flags = 0, notoriety = 1 }) {
  const w = new PacketWriter(17);
  w.writeU8(0x77);
  w.writeU32(serial);
  w.writeU16(body);
  w.writeU16(x);
  w.writeU16(y);
  w.writeI8(z);
  w.writeU8(direction & 0xff);
  w.writeU16(hue);
  w.writeU8(flags & 0xff);
  w.writeU8(notoriety & 0xff);
  return w.bytes();
}

/**
 * 0x22 MovementAck — confirms a 0x02 MovementReq with matching sequence.
 */
export function movementAck(sequence, notoriety = 1) {
  const w = new PacketWriter(3);
  w.writeU8(0x22);
  w.writeU8(sequence & 0xff);
  w.writeU8(notoriety & 0xff);
  return w.bytes();
}

/**
 * 0x21 MovementRej — rejects a 0x02 MovementReq and snaps the client back.
 */
export function movementRej({ sequence, x, y, z, direction = 0 }) {
  const w = new PacketWriter(8);
  w.writeU8(0x21);
  w.writeU8(sequence & 0xff);
  w.writeU16(x);
  w.writeU16(y);
  w.writeU8(direction & 0xff);
  w.writeI8(z);
  return w.bytes();
}

/**
 * 0x17 HealthbarColor — sets a health bar overlay colour for poison/yellow
 * (invulnerable) state. ServUO `Server/Network/Packets.cs::HealthbarPoison`
 * (renamed to HealthbarColor in modern builds). Variable-length so the
 * server can stack multiple colour entries in one push, but in practice
 * we always send a single (kind, level) pair.
 *
 *   u16  count   (always 1)
 *   u16  kind    1 = poison (green tint), 2 = yellow/invulnerable
 *   u8   level   0 = clear, >0 = active. For poison, the value is the
 *                poison level (1..5 stronger = brighter green).
 *
 * @param {{serial:number, kind?:number, level:number}} p
 */
export function healthbarColor({ serial, kind = 1, level }) {
  const w = new PacketWriter(12);
  w.writeU8(0x17);
  w.writeU16(12);
  w.writeU32(serial >>> 0);
  w.writeU16(1);              // count
  w.writeU16(kind & 0xFFFF);
  w.writeU8(level & 0xFF);
  return w.bytes();
}

// Convenience wrappers — clearer call sites than passing raw kind ids.
export function healthbarPoison(serial, level) {
  return healthbarColor({ serial, kind: 1, level });
}
export function healthbarYellow(serial, on) {
  return healthbarColor({ serial, kind: 2, level: on ? 1 : 0 });
}

/**
 * 0x78 MobileIncoming — streams a full mobile (with equipment). Variable-length.
 *
 * @param {object} p
 * @param {number} p.serial
 * @param {number} p.body
 * @param {number} p.x
 * @param {number} p.y
 * @param {number} p.z
 * @param {number} [p.direction]
 * @param {number} [p.hue]
 * @param {number} [p.flags]
 * @param {number} [p.notoriety]
 * @param {Array<{serial:number, itemId:number, layer:number, hue?:number}>} [p.equipment]
 */
export function mobileIncoming({ serial, body, x, y, z, direction = 0, hue = 0, flags = 0, notoriety = 1, equipment = [] }) {
  const w = new PacketWriter(64);
  w.writeU8(0x78);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial);
  w.writeU16(body);
  w.writeU16(x);
  w.writeU16(y);
  w.writeI8(z);
  w.writeU8(direction & 0xff);
  w.writeU16(hue);
  w.writeU8(flags & 0xff);
  w.writeU8(notoriety & 0xff);
  for (const eq of equipment) {
    w.writeU32(eq.serial);
    // The itemId has bit 0x8000 set iff hue is non-zero (client encoding).
    const hasHue = (eq.hue ?? 0) !== 0;
    w.writeU16(hasHue ? (eq.itemId | 0x8000) : (eq.itemId & 0x7FFF));
    w.writeU8(eq.layer & 0xff);
    if (hasHue) w.writeU16(eq.hue);
  }
  w.writeU32(0); // terminator
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
