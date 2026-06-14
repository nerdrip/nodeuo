// FAZA DC — 0xBF 0xCD VirtueState round-trip.

import { describe, it, expect } from 'vitest';
import { extVirtueState } from '../src/packets/extended-commands.js';

describe('extVirtueState (0xBF 0xCD)', () => {
  it('emits the canonical 8 × u32 layout', () => {
    const bytes = extVirtueState({
      humility: 100, sacrifice: 200, compassion: 300, spirituality: 400,
      valor: 500, honor: 600, justice: 700, honesty: 800,
    });
    expect(bytes[0]).toBe(0xBF);
    // length field (u16 BE at [1..2]) covers entire packet.
    const len = (bytes[1] << 8) | bytes[2];
    expect(len).toBe(bytes.length);
    // subcmd at [3..4] = 0x00CD.
    expect((bytes[3] << 8) | bytes[4]).toBe(0xCD);
    // Body: 8 × u32 BE starting at offset 5.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(5,  false)).toBe(100);
    expect(dv.getUint32(9,  false)).toBe(200);
    expect(dv.getUint32(13, false)).toBe(300);
    expect(dv.getUint32(17, false)).toBe(400);
    expect(dv.getUint32(21, false)).toBe(500);
    expect(dv.getUint32(25, false)).toBe(600);
    expect(dv.getUint32(29, false)).toBe(700);
    expect(dv.getUint32(33, false)).toBe(800);
  });

  it('coerces missing virtues to zero', () => {
    const bytes = extVirtueState({ valor: 4000 });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(5,  false)).toBe(0);    // humility default
    expect(dv.getUint32(21, false)).toBe(4000); // valor
    expect(dv.getUint32(33, false)).toBe(0);    // honesty default
  });
});
