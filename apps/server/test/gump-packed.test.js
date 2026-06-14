// 0xDD DisplayGumpPacked round-trip + auto-promotion in handlers.gumps.send.

import { describe, it, expect } from 'vitest';
import { displayGumpPacked, readGumpPacked, PACKED_GUMP_THRESHOLD }
  from '../src/net/gump-packed.js';

describe('0xDD DisplayGumpPacked', () => {
  it('round-trips a small layout + texts', () => {
    const layout = '{ page 0 }{ resizepic 0 0 5054 200 100 }{ text 10 10 0 0 }';
    const texts = ['Hello', 'World'];
    const pkt = displayGumpPacked({
      serial: 0x1234, gumpId: 0xABCD, x: 50, y: 60, layout, texts,
    });
    expect(pkt[0]).toBe(0xDD);
    const back = readGumpPacked(pkt);
    expect(back.serial).toBe(0x1234);
    expect(back.gumpId).toBe(0xABCD);
    expect(back.x).toBe(50);
    expect(back.y).toBe(60);
    expect(back.layout).toBe(layout);
    expect(back.texts).toEqual(texts);
  });

  it('round-trips an empty texts table', () => {
    const layout = '{ page 0 }{ button 10 10 0x800 0x801 1 0 1 }';
    const pkt = displayGumpPacked({
      serial: 1, gumpId: 1, layout, texts: [],
    });
    const back = readGumpPacked(pkt);
    expect(back.layout).toBe(layout);
    expect(back.texts).toEqual([]);
  });

  it('round-trips Unicode characters in texts (BE u16)', () => {
    const layout = '{ text 0 0 0 0 }';
    const texts = ['Zażółć gęślą jaźń', '日本語'];
    const pkt = displayGumpPacked({ serial: 7, gumpId: 7, layout, texts });
    const back = readGumpPacked(pkt);
    expect(back.texts).toEqual(texts);
  });

  it('compresses well — large repetitive layouts shrink dramatically', () => {
    // Repeating layout of ~10KB should compress to well under the original size.
    const cmd = '{ text 100 100 0 0 }';
    const layout = cmd.repeat(500); // 10000 bytes uncompressed
    const pkt = displayGumpPacked({
      serial: 1, gumpId: 1, layout, texts: ['x'],
    });
    expect(pkt.length).toBeLessThan(layout.length / 4);
    const back = readGumpPacked(pkt);
    expect(back.layout).toBe(layout);
  });

  it('encodes the declared length field correctly', () => {
    const layout = '{ page 0 }';
    const pkt = displayGumpPacked({ serial: 0, gumpId: 0, layout, texts: [] });
    const declared = (pkt[1] << 8) | pkt[2];
    expect(declared).toBe(pkt.length);
  });

  it('threshold is 2048 bytes', () => {
    expect(PACKED_GUMP_THRESHOLD).toBe(2048);
  });
});
