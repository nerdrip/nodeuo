// 0xB9 Supported Features bitmask (post-6.0.14.2 extended to u32).
// ServUO: `SupportedFeatures`.

import { PacketWriter } from '../buffer.js';

export const ClientFlags = Object.freeze({
  None:        0x00000,
  T2A:         0x00001,
  ReNaissance: 0x00002,
  ThirdDawn:   0x00004,
  LBR:         0x00008,
  AOS:         0x00010,
  SixthChar:   0x00020,
  SE:          0x00040,
  ML:          0x00080,
  EighthAge:   0x00100,
  NinthAge:    0x00200,
  TenthAge:    0x00400,
  IncreasedStorage:0x00800,
  SeventhChar: 0x01000,
  Roleplay:    0x02000,
  EleventhAge: 0x04000,
  SA:          0x08000,
  HS:          0x10000,
  Gothic:      0x20000,
  Rustic:      0x40000,
  Jungle:      0x80000,
  Shadowguard: 0x100000,
  TOL:         0x200000,
  EJ:          0x400000,
});

export const DEFAULT_FEATURES =
  ClientFlags.T2A | ClientFlags.ReNaissance | ClientFlags.ThirdDawn |
  ClientFlags.LBR | ClientFlags.AOS | ClientFlags.SE | ClientFlags.ML |
  ClientFlags.SA | ClientFlags.SixthChar | ClientFlags.SeventhChar;

/** @param {number} [flags] */
export function supportedFeatures(flags = DEFAULT_FEATURES) {
  const w = new PacketWriter(5);
  w.writeU8(0xB9);
  w.writeU32(flags >>> 0);
  return w.bytes();
}
