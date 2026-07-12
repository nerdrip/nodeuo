import { describe, it, expect } from 'vitest';
import { buffAdd, buffRemove } from '../src/packets/buff-info.js';
import { PacketReader } from '../src/buffer.js';

function unicode(r) {
  const length = r.readU16();
  let value = '';
  for (let i = 0; i < length; i++) value += String.fromCharCode(r.readU16());
  return value;
}

function parse(pkt) {
  const r = new PacketReader(pkt);
  const op = r.readU8(); const len = r.readU16(); const serial = r.readU32();
  const icon = r.readU16(); const action = r.readU16();
  if (action === 0) return { op, len, serial, icon, action };
  r.readU16();
  const duration = r.readU16();
  r.readU8(); r.readU8(); r.readU8();
  const titleCliloc = r.readU32(); const secondaryCliloc = r.readU32(); r.readU32();
  return { op, len, serial, icon, action, duration, titleCliloc, secondaryCliloc, title: unicode(r), secondary: unicode(r) };
}

describe('canonical 0xDF BuffInfo', () => {
  it('encodes standard field order and bounded unicode arguments', () => {
    const p = buffAdd({ serial: 0x1234, icon: 0x418, name: 'bless', kind: 'buff', remainingMs: 60_000 });
    const x = parse(p);
    expect(x).toMatchObject({
      op: 0xDF, len: p.length, serial: 0x1234, icon: 0x418, action: 1,
      duration: 60, titleCliloc: 1042971, secondaryCliloc: 1042971,
      title: 'bless', secondary: 'buff',
    });
  });

  it('encodes the canonical fixed remove packet', () => {
    const p = buffRemove({ serial: 0x1234, icon: 0x40E });
    expect(p.length).toBe(11);
    expect(parse(p)).toEqual({ op: 0xDF, len: 11, serial: 0x1234, icon: 0x40E, action: 0 });
  });

  it('clamps negative duration and caps long strings', () => {
    const p = buffAdd({ serial: 1, name: 'a'.repeat(300), remainingMs: -500 });
    const x = parse(p);
    expect(x.duration).toBe(0);
    expect(x.title).toHaveLength(128);
    expect(x.len).toBe(p.length);
  });
});
