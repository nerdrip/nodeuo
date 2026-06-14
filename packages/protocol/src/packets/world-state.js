// 0xBC Season change — sets the client-side season (0 Spring, 1 Summer,
// 2 Fall, 3 Winter, 4 Desolation) plus a play-music flag. ServUO: `SeasonChange`.
//
// Layout (3 bytes): u8 0xBC, u8 season, u8 playSound
//
// 0x4F Overall Light Level: u8 0x4F, u8 level (0x00 = bright, 0x1F = black).

import { PacketWriter } from '../buffer.js';

export function seasonChange(season = 1, playSound = 1) {
  const w = new PacketWriter(3);
  w.writeU8(0xBC);
  w.writeU8(season & 0xff);
  w.writeU8(playSound ? 1 : 0);
  return w.bytes();
}

export function overallLightLevel(level = 0) {
  const w = new PacketWriter(2);
  w.writeU8(0x4F);
  w.writeU8(level & 0xff);
  return w.bytes();
}

/** Personal light level for a mobile (0x4E). */
export function personalLightLevel(serial, level = 0) {
  const w = new PacketWriter(6);
  w.writeU8(0x4E);
  w.writeU32(serial);
  w.writeU8(level & 0xff);
  return w.bytes();
}
