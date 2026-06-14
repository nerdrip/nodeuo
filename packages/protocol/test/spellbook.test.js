import { describe, it, expect } from 'vitest';
import { extNewSpellbookContent } from '../src/packets/extended-commands.js';

describe('0xBF 0x1B NewSpellbookContent', () => {
  it('encodes a 64-bit content mask big-endian', () => {
    // All 64 spells known (content = 2^64 - 1).
    const pkt = extNewSpellbookContent({
      serial: 0x40001000,
      offset: 1,
      content: 0xFFFFFFFFFFFFFFFFn,
    });
    expect(pkt[0]).toBe(0xBF);
    const len = (pkt[1] << 8) | pkt[2];
    expect(len).toBe(pkt.length);
    // sub-cmd at offset 3-4.
    expect((pkt[3] << 8) | pkt[4]).toBe(0x1B);
    // unknown (always 1) at 5-6.
    expect((pkt[5] << 8) | pkt[6]).toBe(1);
    // serial at 7-10.
    const serial = (pkt[7] << 24 | pkt[8] << 16 | pkt[9] << 8 | pkt[10]) >>> 0;
    expect(serial).toBe(0x40001000);
    // offset at 11-12.
    expect((pkt[11] << 8) | pkt[12]).toBe(1);
    // 8 bytes of 0xFF.
    for (let i = 13; i < 21; i++) expect(pkt[i]).toBe(0xFF);
  });

  it('defaults offset to 1 and encodes partial masks', () => {
    // Just spell 1 (Magery Clumsy) known => bit 0 set => LSB 0x01.
    const pkt = extNewSpellbookContent({ serial: 0x42, content: 0x01n });
    expect((pkt[11] << 8) | pkt[12]).toBe(1);
    // Last byte should be 0x01, preceding seven bytes 0x00.
    for (let i = 13; i < 20; i++) expect(pkt[i]).toBe(0x00);
    expect(pkt[20]).toBe(0x01);
  });
});
