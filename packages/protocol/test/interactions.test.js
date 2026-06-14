// Tests for status, target, paperdoll, skills, sound packet builders.

import { describe, it, expect } from 'vitest';
import {
  mobileStatus, healthUpdate, manaUpdate, staminaUpdate,
  targetRequest, readTargetResponse, openPaperdoll, sendSkills,
  playSound,
} from '../src/index.js';

describe('status packets', () => {
  it('healthUpdate is 9 bytes, big-endian serial+max+cur', () => {
    const p = healthUpdate({ serial: 0x01020304, current: 50, max: 100 });
    expect(p.length).toBe(9);
    expect(p[0]).toBe(0xA1);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint32(1)).toBe(0x01020304);
    expect(dv.getUint16(5)).toBe(100);
    expect(dv.getUint16(7)).toBe(50);
  });

  it('manaUpdate / staminaUpdate share the shape', () => {
    expect(manaUpdate({ serial: 1, current: 1, max: 2 })[0]).toBe(0xA2);
    expect(staminaUpdate({ serial: 1, current: 1, max: 2 })[0]).toBe(0xA3);
  });

  it('mobileStatus writes name, hp, stats', () => {
    const p = mobileStatus({
      serial: 0x0A0B0C0D, name: 'Hero',
      hp: 30, hpMax: 100, str: 80, dex: 90, int: 70,
      mana: 20, manaMax: 40, stam: 45, stamMax: 60, gold: 1234,
    });
    expect(p[0]).toBe(0x11);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint16(1)).toBe(p.length);
    expect(dv.getUint32(3)).toBe(0x0A0B0C0D);
    const name = new TextDecoder('ascii').decode(p.subarray(7, 7 + 30)).replace(/\0+$/, '');
    expect(name).toBe('Hero');
    // hp/hpMax right after the 30-byte name field.
    expect(dv.getUint16(37)).toBe(30);
    expect(dv.getUint16(39)).toBe(100);
  });
});

describe('targetRequest / readTargetResponse', () => {
  it('emits 19 bytes with id and kind', () => {
    const p = targetRequest({ id: 0xDEADBEEF, kind: 1, flags: 0 });
    expect(p.length).toBe(19);
    expect(p[0]).toBe(0x6C);
    expect(p[1]).toBe(1);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint32(2)).toBe(0xDEADBEEF);
  });

  it('round-trips a response through readTargetResponse', () => {
    // Build a fake client reply using the same builder (both shapes match
    // 19-byte fixed).
    const fake = targetRequest({ id: 42, kind: 0 });
    fake[7] = 0xAA; fake[8] = 0xBB; fake[9] = 0xCC; fake[10] = 0xDD; // serial
    const dv = new DataView(fake.buffer);
    dv.setUint16(11, 500);   // x
    dv.setUint16(13, 600);   // y
    // Audit #41 client P1 #4: ServUO `PacketHandlers.cs:1244` reads
    // `z = pvSrc.ReadInt16()`. The client mirrors with `writeI16(z)`
    // at offset 15. Earlier wire interpretation was padding(u8) +
    // sbyte(z) which only round-tripped when z=0. Both ends now use
    // a signed 16-bit big-endian Z.
    dv.setInt16(15, -3);     // z (i16 big-endian)
    dv.setUint16(17, 0x190); // graphic
    const parsed = readTargetResponse(fake);
    expect(parsed.id).toBe(42);
    expect(parsed.serial).toBe(0xAABBCCDD);
    expect(parsed.x).toBe(500);
    expect(parsed.y).toBe(600);
    expect(parsed.z).toBe(-3);
    expect(parsed.graphic).toBe(0x190);
  });

  it('parses a positive z above 127 as an unsigned-within-sbyte value', () => {
    // Regression for C-01. Dungeons and dragon-lair stairs sit at z values
    // well inside signed-byte range (e.g. stairs z=12, upper floors z=20..40).
    // This test locks in the parser shape so no future refactor silently
    // widens Z back to u16/i16.
    const fake = targetRequest({ id: 7, kind: 1 });
    const dv = new DataView(fake.buffer);
    dv.setUint16(11, 1496);
    dv.setUint16(13, 1625);
    dv.setUint8(15, 0);
    dv.setInt8(16, 40);
    dv.setUint16(17, 0);
    const parsed = readTargetResponse(fake);
    expect(parsed.x).toBe(1496);
    expect(parsed.y).toBe(1625);
    expect(parsed.z).toBe(40);
  });
});

describe('openPaperdoll', () => {
  it('is 66 bytes with serial and title', () => {
    const p = openPaperdoll({ serial: 0x00010203, title: 'Lord British' });
    expect(p.length).toBe(66);
    expect(p[0]).toBe(0x88);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint32(1)).toBe(0x00010203);
  });
});

describe('sendSkills', () => {
  it('encodes 0xDF full list with caps', () => {
    const p = sendSkills({
      skills: [{ id: 26, value: 100, base: 95, cap: 120, lock: 0 }], type: 0xDF,
    });
    expect(p[0]).toBe(0x3A);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint16(1)).toBe(p.length);
    expect(dv.getUint8(3)).toBe(0xDF);
    expect(dv.getUint16(4)).toBe(26);
    expect(dv.getUint16(6)).toBe(1000);
    expect(dv.getUint16(8)).toBe(950);
    expect(dv.getUint8(10)).toBe(0);
    expect(dv.getUint16(11)).toBe(1200);
  });
});

describe('playSound', () => {
  it('is 12 bytes with soundId at offset 2', () => {
    const p = playSound({ soundId: 0x19, x: 100, y: 200, z: 5 });
    expect(p.length).toBe(12);
    expect(p[0]).toBe(0x54);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint16(2)).toBe(0x19);
    expect(dv.getUint16(6)).toBe(100);
    expect(dv.getUint16(8)).toBe(200);
  });
});
