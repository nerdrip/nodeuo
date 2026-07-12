// Graphical effects:
//
//   0x70  GraphicalEffect             — classic (targeted / moving / lightning)
//   0xC0  HuedEffect                  — same as 0x70 + hue + render mode
//
// Layout (both packets are fixed-length):
//   0x70: u8 op, u8 kind, u32 from, u32 to, u16 itemId, u16 fromX, u16 fromY,
//         i8 fromZ, u16 toX, u16 toY, i8 toZ, u8 speed, u8 duration,
//         u16 unknown1=0, u8 fixedDirection, u8 explodes
//   0xC0: 0x70 body + u32 hue + u32 renderMode
//
// kind:
//   0x00  moving (from-to)
//   0x01  lightning (strikes the target)
//   0x02  fixed at source XYZ
//   0x03  fixed-from, follows source
//   0x04  screen fade
//   0x05  custom drag/tether effect

import { PacketWriter } from '../buffer.js';

export const EffectKind = Object.freeze({
  Moving: 0x00,
  Lightning: 0x01,
  FixedXYZ: 0x02,
  Stationary: 0x02,
  FixedFrom: 0x03,
  FromSource: 0x03,
  ScreenFade: 0x04,
  DragEffect: 0x05,
});

function writeEffectBody(w, p) {
  w.writeU8(p.kind & 0xff);
  w.writeU32((p.from ?? 0) >>> 0);
  w.writeU32((p.to ?? 0) >>> 0);
  w.writeU16((p.itemId ?? 0) & 0xffff);
  w.writeU16((p.fromX ?? 0) & 0xffff);
  w.writeU16((p.fromY ?? 0) & 0xffff);
  w.writeI8(p.fromZ ?? 0);
  w.writeU16((p.toX ?? 0) & 0xffff);
  w.writeU16((p.toY ?? 0) & 0xffff);
  w.writeI8(p.toZ ?? 0);
  w.writeU8((p.speed ?? 1) & 0xff);
  w.writeU8((p.duration ?? 0) & 0xff);
  w.writeU16(0); // unknown
  w.writeU8(p.fixedDirection ? 1 : 0);
  w.writeU8(p.explodes ? 1 : 0);
}

/**
 * 0x70 Graphical effect — 28 bytes fixed.
 */
export function graphicalEffect(p) {
  const w = new PacketWriter(28);
  w.writeU8(0x70);
  writeEffectBody(w, p);
  return w.bytes();
}

/**
 * 0xC0 Hued effect — 36 bytes fixed.
 */
export function huedEffect(p) {
  const w = new PacketWriter(36);
  w.writeU8(0xC0);
  writeEffectBody(w, p);
  w.writeU32((p.hue ?? 0) >>> 0);
  w.writeU32((p.renderMode ?? 0) >>> 0);
  return w.bytes();
}
