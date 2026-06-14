// 0xA9 Character List / Starting locations. Sent after the client completes
// the 0x91 GameLogin handshake. ServUO: `CharacterList`, `CharacterListOld`.
//
// We implement the post-6.0.x layout used by 7.0.x clients:
//
//   u8 0xA9
//   u16 length (patched)
//   u8 charCount (always 7; unused slots are zero-filled)
//   7 × { char[30] name, char[30] password }   password field is always empty
//   u8 locCount
//   locCount × {
//     u8 index
//     char[32] cityName
//     char[32] areaName
//     u32 x
//     u32 y
//     u32 z
//     u32 mapIndex
//     u32 clilocDescription
//     u32 reserved (0)
//   }
//   u32 flags
//   u16 lastCharSlot

import { PacketWriter } from '../buffer.js';

export const CharacterListFlags = Object.freeze({
  Unknown:        0x001,
  SendConfigInfo: 0x002,
  SingleChar:     0x004,
  SlotLimit:      0x008,
  AllSkills:      0x010,
  ContextMenus:   0x020,
  LimitChar:      0x040,
  PaladinNecroBT: 0x080,
  SixthCharSlot:  0x100,
  SamuraiNinja:   0x200,
  Elven:          0x400,
  KR:             0x800,
  SeventhChar:    0x1000,
  NewMovement:    0x4000,
  UnlockFeatures: 0x8000,
  Default7000:    0x1408,
});

/**
 * @typedef {Object} StartingLocation
 * @property {string} city
 * @property {string} area
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} [mapIndex]  facet id, default 0 (Felucca)
 * @property {number} [clilocDescription]  cliloc id, default 0
 */

/**
 * @param {Array<{name:string}>} characters  1..7 entries; rest padded with empty slots
 * @param {StartingLocation[]} locations
 * @param {number} [flags]
 * @param {number} [lastSlot]
 */
export function characterList(characters, locations, flags = CharacterListFlags.Default7000, lastSlot = 0) {
  const slots = 7;
  const w = new PacketWriter(256);
  w.writeU8(0xA9);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU8(slots);
  for (let i = 0; i < slots; i++) {
    const c = characters[i];
    w.writeAsciiFixed(c?.name ?? '', 30);
    w.writeAsciiFixed('', 30); // password always blank
  }
  w.writeU8(locations.length);
  for (let i = 0; i < locations.length; i++) {
    const l = locations[i];
    w.writeU8(i);
    w.writeAsciiFixed(l.city, 32);
    w.writeAsciiFixed(l.area, 32);
    w.writeU32(l.x);
    w.writeU32(l.y);
    w.writeU32(l.z);
    w.writeU32(l.mapIndex ?? 0);
    w.writeU32(l.clilocDescription ?? 0);
    w.writeU32(0);
  }
  w.writeU32(flags >>> 0);
  w.writeU16(lastSlot);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
