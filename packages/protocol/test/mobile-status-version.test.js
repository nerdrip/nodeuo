// PHASE CL — bugfix #54: mobileStatus packet honours `version` to gate
// how much data is serialised. Version 0x00 (used for non-self status
// requests) ships only name + HP. Without this gate the server leaked
// every stat to anyone who dragged out a stranger's status bar.

import { describe, it, expect } from 'vitest';
import { mobileStatus } from '../src/packets/status.js';

function readU16BE(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

describe('mobileStatus version (bugfix #54)', () => {
  it('default version 0x05 emits the full extended layout (resists+luck+dmg+tithing)', () => {
    const pkt = mobileStatus({
      serial: 0x100, name: 'Hero', hp: 50, hpMax: 50,
      mana: 30, manaMax: 50, stam: 40, stamMax: 50,
      str: 80, dex: 60, int: 40, gold: 999,
    });
    // u8 op + u16 len + u32 serial + 30 name + u16 hp + u16 hpMax
    // + u8 canRename + u8 version (= 0x05) + extended (>=21 bytes).
    // Default bumped from 0x04 → 0x05 so the status gump shows resist /
    // luck / damage-range / tithing instead of '-' for those slots
    // (client decoder gates extended fields on version >= 0x05).
    expect(pkt[0]).toBe(0x11);
    const len = readU16BE(pkt, 1);
    expect(pkt[42]).toBe(0x05);          // version byte
    expect(len).toBeGreaterThan(43 + 20); // extended payload present
  });

  it('version 0x00 emits the brief layout — no extended fields', () => {
    const pkt = mobileStatus({
      serial: 0x100, name: 'Stranger', hp: 50, hpMax: 50,
      version: 0x00,
    });
    expect(pkt[0]).toBe(0x11);
    expect(pkt[42]).toBe(0x00);
    const len = readU16BE(pkt, 1);
    // op(1) + len(2) + serial(4) + name(30) + hp(2) + hpMax(2) +
    // canRename(1) + version(1) = 43 bytes. No extended payload.
    expect(len).toBe(43);
  });

  it('brief layout still ships hp+hpMax — what the status bar reads', () => {
    const pkt = mobileStatus({
      serial: 0x100, name: 'Wolf', hp: 73, hpMax: 100, version: 0x00,
    });
    // hp at offset 37 (op + 2len + 4serial + 30name = 37)
    expect(readU16BE(pkt, 37)).toBe(73);
    expect(readU16BE(pkt, 39)).toBe(100);
  });
});
