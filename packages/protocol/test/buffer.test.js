import { describe, it, expect } from 'vitest';
import { PacketReader, PacketWriter } from '../src/buffer.js';

describe('PacketWriter / PacketReader', () => {
  it('writes and reads big-endian integers', () => {
    const w = new PacketWriter();
    w.writeU8(0x12);
    w.writeU16(0xABCD);
    w.writeU32(0xDEADBEEF);
    w.writeI16(-1);
    w.writeI32(-2);

    const r = new PacketReader(w.bytes());
    expect(r.readU8()).toBe(0x12);
    expect(r.readU16()).toBe(0xABCD);
    expect(r.readU32()).toBe(0xDEADBEEF);
    expect(r.readI16()).toBe(-1);
    expect(r.readI32()).toBe(-2);
    expect(r.remaining).toBe(0);
  });

  it('encodes u16 in big-endian on the wire (sanity check)', () => {
    const w = new PacketWriter();
    w.writeU16(0x1234);
    const b = w.bytes();
    expect(b[0]).toBe(0x12);
    expect(b[1]).toBe(0x34);
  });

  it('grows buffer beyond initial capacity', () => {
    const w = new PacketWriter(2);
    for (let i = 0; i < 1000; i++) w.writeU8(i & 0xff);
    expect(w.bytes().length).toBe(1000);
    const r = new PacketReader(w.bytes());
    for (let i = 0; i < 1000; i++) expect(r.readU8()).toBe(i & 0xff);
  });

  it('round-trips ASCII null-terminated strings', () => {
    const w = new PacketWriter();
    w.writeAsciiNull('admin');
    w.writeAsciiNull('');
    const r = new PacketReader(w.bytes());
    expect(r.readAsciiNull()).toBe('admin');
    expect(r.readAsciiNull()).toBe('');
  });

  it('round-trips ASCII fixed-length (null-padded)', () => {
    const w = new PacketWriter();
    w.writeAsciiFixed('abc', 30);
    expect(w.bytes().length).toBe(30);
    const r = new PacketReader(w.bytes());
    expect(r.readAsciiFixed(30)).toBe('abc');
  });

  it('round-trips UTF-16 BE null-terminated strings', () => {
    const w = new PacketWriter();
    w.writeUnicodeNull('Hêllo');
    const r = new PacketReader(w.bytes());
    expect(r.readUnicodeNull()).toBe('Hêllo');
  });

  it('setU16At patches a variable-length size field', () => {
    const w = new PacketWriter();
    w.writeU8(0xBF);          // opcode
    w.writeU16(0);            // length placeholder
    w.writeU16(0x0008);       // sub-command
    w.writeU32(0x11223344);   // body
    w.setU16At(1, w.length);  // patch length = total packet size
    const b = w.bytes();
    expect(b[0]).toBe(0xBF);
    expect((b[1] << 8) | b[2]).toBe(b.length);
  });

  it('throws on read underflow', () => {
    const r = new PacketReader(new Uint8Array([0x01]));
    expect(() => r.readU32()).toThrow(RangeError);
  });
});
