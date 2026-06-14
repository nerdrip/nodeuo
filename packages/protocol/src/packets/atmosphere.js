// Weather packet (0x65).
//
// 0xBC Season and 0x4F/0x4E light levels live in world-state.js.

import { PacketWriter } from '../buffer.js';

export const WeatherKind = Object.freeze({
  Dry: 0xFE,        // stop current weather
  Rain: 0x00,
  FierceStorm: 0x01,
  Snow: 0x02,       // some client versions only
  Storm: 0x03,
});

export const Season = Object.freeze({
  Spring: 0, Summer: 1, Fall: 2, Winter: 3, Desolation: 4,
});

/**
 * 0x65 Weather — 4 bytes.
 *
 * @param {Object} p
 * @param {number} p.kind        WeatherKind.*
 * @param {number} [p.intensity] number of effects (0..70)
 * @param {number} [p.temperature]
 */
export function weather({ kind, intensity = 0, temperature = 0x20 }) {
  const w = new PacketWriter(4);
  w.writeU8(0x65);
  w.writeU8(kind & 0xff);
  w.writeU8(intensity & 0xff);
  w.writeU8(temperature & 0xff);
  return w.bytes();
}

/**
 * 0x6D PlayMusic — 3 bytes. UO classic uses this for the looping MIDI
 * track tied to the player's current region. `id` is a 16-bit slot in
 * `Music.cfg`; modern shards use 0..255 but the wire field is u16 to
 * stay layout-compatible. Pass `id = 0xFFFF` to STOP music (ServUO
 * behaviour — the client treats that as silence).
 */
export function playMusic(id = 0) {
  const w = new PacketWriter(3);
  w.writeU8(0x6D);
  w.writeU16(id & 0xffff);
  return w.bytes();
}
