// Wave G: graphical effects, object properties, quest arrow.

import { describe, it, expect } from 'vitest';
import {
  graphicalEffect, huedEffect, EffectKind,
  oplInfo, objectProperties, readOPLRequest, computeOPLHash,
  questArrow,
} from '../src/index.js';
import { PacketWriter } from '../src/buffer.js';

describe('effects', () => {
  it('graphicalEffect is 28 bytes fixed', () => {
    const pkt = graphicalEffect({
      kind: EffectKind.Stationary,
      from: 1, to: 2, itemId: 0x36BD,
      fromX: 10, fromY: 20, fromZ: 0,
      toX: 30, toY: 40, toZ: 0,
      speed: 5, duration: 15,
    });
    expect(pkt.length).toBe(28);
    expect(pkt[0]).toBe(0x70);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(1)).toBe(EffectKind.Stationary);
    expect(dv.getUint32(2)).toBe(1);
    expect(dv.getUint32(6)).toBe(2);
    expect(dv.getUint16(10)).toBe(0x36BD);
    expect(dv.getUint16(12)).toBe(10);
    expect(dv.getUint16(14)).toBe(20);
  });

  it('huedEffect is 36 bytes and carries hue + render mode', () => {
    const pkt = huedEffect({
      kind: EffectKind.Moving,
      from: 1, to: 2, itemId: 0x3728,
      fromX: 0, fromY: 0, fromZ: 0,
      toX: 10, toY: 10, toZ: 0,
      speed: 7, duration: 20,
      hue: 0x04EC, renderMode: 4,
    });
    expect(pkt.length).toBe(36);
    expect(pkt[0]).toBe(0xC0);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint32(28)).toBe(0x04EC);
    expect(dv.getUint32(32)).toBe(4);
  });
});

describe('object properties', () => {
  it('oplInfo packs serial and hash', () => {
    const pkt = oplInfo(0x4000BEEF, 0xDEADBEEF);
    expect(pkt.length).toBe(9);
    expect(pkt[0]).toBe(0xDC);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint32(1)).toBe(0x4000BEEF);
    expect(dv.getUint32(5)).toBe(0xDEADBEEF);
  });

  it('objectProperties emits length-prefixed UTF-16LE args and terminator', () => {
    const entries = [{ cliloc: 1042971, args: 'apple' }];
    const pkt = objectProperties({ serial: 1, hash: 0xAA, entries });
    expect(pkt[0]).toBe(0xD6);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(1)).toBe(pkt.length);
    expect(dv.getUint16(3)).toBe(0x0001);
    expect(dv.getUint32(5)).toBe(1);
    expect(dv.getUint16(9)).toBe(0x0000);
    expect(dv.getUint32(11)).toBe(0xAA);
    expect(dv.getUint32(15)).toBe(1042971);
    expect(dv.getUint16(19)).toBe(10); // "apple" = 5 chars × 2 bytes
    expect(pkt[21]).toBe(0x61); // 'a' low byte
    expect(pkt[22]).toBe(0x00); // high byte (LE)
    // Terminator u32 = 0.
    expect(dv.getUint32(pkt.length - 4)).toBe(0);
  });

  it('readOPLRequest parses a list of serials', () => {
    const w = new PacketWriter(32);
    w.writeU8(0xD6); const lp = w.length; w.writeU16(0);
    w.writeU32(0x01); w.writeU32(0x02); w.writeU32(0x03);
    w.setU16At(lp, w.length);
    expect(readOPLRequest(w.bytes())).toEqual({ serials: [1, 2, 3] });
  });

  it('computeOPLHash is stable and content-sensitive', () => {
    const a = computeOPLHash([{ cliloc: 1, args: 'hi' }]);
    const b = computeOPLHash([{ cliloc: 1, args: 'hi' }]);
    const c = computeOPLHash([{ cliloc: 1, args: 'bye' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('quest arrow', () => {
  it('questArrow carries active flag and coordinates', () => {
    const pkt = questArrow({ active: true, x: 1500, y: 1600, serial: 0x2A });
    expect(pkt[0]).toBe(0xBA);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(1)).toBe(1);
    expect(dv.getUint16(2)).toBe(1500);
    expect(dv.getUint16(4)).toBe(1600);
    expect(dv.getUint32(6)).toBe(0x2A);
  });

  it('questArrow can clear', () => {
    const pkt = questArrow({ active: false, x: 0, y: 0 });
    expect(pkt.length).toBe(6);
    expect(pkt[1]).toBe(0);
  });
});
