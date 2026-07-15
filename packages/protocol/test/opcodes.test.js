import { describe, it, expect } from 'vitest';
import { frameIncoming, INCOMING_OPCODES } from '../src/opcodes.js';

describe('frameIncoming', () => {
  it('frames a single fixed-length packet', () => {
    // 0x73 (PingReq) is 2 bytes: opcode + 1-byte seq
    const buf = new Uint8Array([0x73, 0x42]);
    const { packets, consumed } = frameIncoming(buf);
    expect(consumed).toBe(2);
    expect(packets.length).toBe(1);
    expect(packets[0][0]).toBe(0x73);
  });

  it('frames multiple concatenated packets', () => {
    const buf = new Uint8Array([
      0x73, 0x00,                           // ping (size 2)
      0x02, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, // movement (size 7)
    ]);
    const { packets, consumed } = frameIncoming(buf);
    expect(consumed).toBe(9);
    expect(packets.length).toBe(2);
    expect(packets[0].length).toBe(2);
    expect(packets[1].length).toBe(7);
    expect(packets[1][0]).toBe(0x02);
  });

  it('holds back an incomplete trailing packet', () => {
    const buf = new Uint8Array([
      0x73, 0x00,
      0x02, 0x01,             // partial movement (only 4 of 7 bytes)
    ]);
    const { packets, consumed } = frameIncoming(buf);
    expect(consumed).toBe(2);
    expect(packets.length).toBe(1);
  });

  it('handles variable-length packets using u16 big-endian length', () => {
    // 0x03 AsciiSpeech is VAR; build a minimal valid frame.
    const body = new TextEncoder().encode('hi\0');
    const size = 1 + 2 + 1 + 2 + 2 + body.length; // opcode + length + mode + hue + font + msg
    const buf = new Uint8Array(size);
    buf[0] = 0x03;
    buf[1] = (size >> 8) & 0xff;
    buf[2] = size & 0xff;
    // remaining bytes unused for the framer — it only cares about length
    const { packets, consumed } = frameIncoming(buf);
    expect(consumed).toBe(size);
    expect(packets.length).toBe(1);
    expect(packets[0].length).toBe(size);
  });

  it('throws on unknown opcode', () => {
    expect(() => frameIncoming(new Uint8Array([0xFF, 0x00, 0x00]))).toThrow();
  });

  it('honours a packet budget and leaves the remaining coalesced bytes intact', () => {
    const buf = new Uint8Array([0x73, 1, 0x73, 2, 0x73, 3]);
    const first = frameIncoming(buf, { maxPackets: 2 });
    expect(first).toMatchObject({ consumed: 4, limited: true });
    expect(first.packets.map((p) => p[1])).toEqual([1, 2]);
    const second = frameIncoming(buf.subarray(first.consumed), { maxPackets: 2 });
    expect(second).toMatchObject({ consumed: 2, limited: false });
    expect(second.packets[0][1]).toBe(3);
  });

  it('exposes the valid packet prefix when a malformed tail follows it', () => {
    const buf = new Uint8Array([
      0x02, 0x07, 0x40, 0x2b, 0xfb, 0x96, 0x02,
      0x26,
    ]);

    try {
      frameIncoming(buf);
      throw new Error('expected framing to fail');
    } catch (error) {
      expect(error.offset).toBe(7);
      expect(error.consumed).toBe(7);
      expect(error.packets).toHaveLength(1);
      expect(Array.from(error.packets[0])).toEqual(Array.from(buf.subarray(0, 7)));
    }
  });

  it('size table includes critical login opcodes', () => {
    expect(INCOMING_OPCODES[0x80].size).toBe(62);
    expect(INCOMING_OPCODES[0x91].size).toBe(65);
    expect(INCOMING_OPCODES[0xEF].size).toBe(21);
    expect(INCOMING_OPCODES[0xA0].size).toBe(3);
  });

  it('frames ServUO script-registered opcodes before server dispatch', () => {
    expect(INCOMING_OPCODES[0x66].size).toBe(0);
    expect(INCOMING_OPCODES[0x71].size).toBe(0);
    expect(INCOMING_OPCODES[0xD4].size).toBe(0);
    expect(INCOMING_OPCODES[0xFA].size).toBe(1);

    const bookHeader = new Uint8Array([0xD4, 0x00, 0x09, 0, 0, 0, 1, 0, 0]);
    const storeReq = new Uint8Array([0xFA]);
    const buf = new Uint8Array(bookHeader.length + storeReq.length);
    buf.set(bookHeader, 0);
    buf.set(storeReq, bookHeader.length);

    const { packets, consumed } = frameIncoming(buf);
    expect(consumed).toBe(buf.length);
    expect(packets.map((p) => p[0])).toEqual([0xD4, 0xFA]);
  });

  it('frames pre-6.0.1.7 14-byte DropReq when requested', () => {
    const legacyDrop = new Uint8Array([
      0x08,
      0x40, 0x00, 0x00, 0x01,
      0x12, 0x34,
      0x56, 0x78,
      0xff,
      0xff, 0xff, 0xff, 0xff,
    ]);
    const ping = new Uint8Array([0x73, 0x01]);
    const buf = new Uint8Array(legacyDrop.length + ping.length);
    buf.set(legacyDrop, 0);
    buf.set(ping, legacyDrop.length);

    const { packets, consumed } = frameIncoming(buf, { dropReqSize: 14 });
    expect(consumed).toBe(buf.length);
    expect(packets.map((p) => p.length)).toEqual([14, 2]);
    expect(packets.map((p) => p[0])).toEqual([0x08, 0x73]);
  });
});
