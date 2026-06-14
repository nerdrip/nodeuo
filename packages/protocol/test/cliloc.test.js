// Tests for 0xC1 MessageLocalized + the tiny cliloc helper.

import { describe, it, expect } from 'vitest';
import { messageLocalized, cliloc } from '../src/index.js';

describe('messageLocalized (0xC1)', () => {
  it('emits the documented header shape', () => {
    const p = messageLocalized({
      serial: 0x0A0B0C0D,
      graphic: 0x0190,
      type: 1,
      hue: 0x0035,
      font: 3,
      name: 'Lord British',
      clilocNumber: 1043124,
      args: 'hello',
    });
    expect(p[0]).toBe(0xC1);
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint16(1)).toBe(p.length);          // length patched in
    expect(dv.getUint32(3)).toBe(0x0A0B0C0D);
    expect(dv.getUint16(7)).toBe(0x0190);
    expect(dv.getUint8(9)).toBe(1);
    expect(dv.getUint16(10)).toBe(0x0035);
    expect(dv.getUint16(12)).toBe(3);
    expect(dv.getUint32(14)).toBe(1043124);
    // Next 30 bytes are the ASCII-fixed name.
    const nameBytes = p.subarray(18, 18 + 30);
    const name = new TextDecoder('ascii').decode(nameBytes).replace(/\0+$/, '');
    expect(name).toBe('Lord British');
  });
});

describe('cliloc helper', () => {
  it('formats ~N_FOO~ tokens from tab-separated args', () => {
    expect(cliloc.format(1043124, 'Greetings, traveler!')).toBe('You hear: Greetings, traveler!');
    expect(cliloc.format(500000, 'Mayor\tHail and well met')).toBe('Mayor says: Hail and well met');
  });

  it('returns a fallback for unknown numbers', () => {
    const out = cliloc.format(9999999, 'x');
    expect(out.startsWith('[cliloc ')).toBe(true);
  });
});
