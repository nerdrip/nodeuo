// 0xDF BuffInfo round-trip.

import { describe, it, expect } from 'vitest';
import { buffAdd, buffRemove } from '../src/packets/buff-info.js';
import { PacketReader } from '../src/buffer.js';

function parse(pkt) {
  const r = new PacketReader(pkt);
  const op = r.readU8();
  const len = r.readU16();
  const action = r.readU8();
  const serial = r.readU32();
  const nameLen = r.readU8();
  const name = r.readAsciiFixed(nameLen);
  const kindLen = r.readU8();
  const kind = r.readAsciiFixed(kindLen);
  const remaining = r.readU32();
  return { op, len, action, serial, name, kind, remaining };
}

describe('0xDF BuffInfo', () => {
  it('buffAdd encodes name/kind/remaining', () => {
    const p = buffAdd({ serial: 0x1234, name: 'bless', kind: 'buff', remainingMs: 60_000 });
    const x = parse(p);
    expect(x.op).toBe(0xDF);
    expect(x.len).toBe(p.length);
    expect(x.action).toBe(1);
    expect(x.serial).toBe(0x1234);
    expect(x.name).toBe('bless');
    expect(x.kind).toBe('buff');
    expect(x.remaining).toBe(60_000);
  });

  it('buffRemove carries action=0 and zero remaining', () => {
    const p = buffRemove({ serial: 0x1234, name: 'poison' });
    const x = parse(p);
    expect(x.action).toBe(0);
    expect(x.name).toBe('poison');
    expect(x.remaining).toBe(0);
  });

  it('debuff kind round-trips', () => {
    const p = buffAdd({ serial: 0x4000, name: 'curse', kind: 'debuff', remainingMs: 30_000 });
    expect(parse(p).kind).toBe('debuff');
  });

  it('clamps negative remainingMs to 0', () => {
    const p = buffAdd({ serial: 1, name: 'bless', remainingMs: -500 });
    expect(parse(p).remaining).toBe(0);
  });

  it('truncates excessively long names instead of overflowing', () => {
    const long = 'a'.repeat(100);
    const p = buffAdd({ serial: 1, name: long });
    const x = parse(p);
    // Name field is capped at 32 bytes — the reader only returns what was
    // written, which is the first 32 chars.
    expect(x.name.length).toBe(32);
  });
});
