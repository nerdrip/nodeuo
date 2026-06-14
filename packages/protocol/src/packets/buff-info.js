// 0xDF BuffInfo — tell the client that a named status effect has been
// attached to or removed from a mobile.
//
// This is a simplified, port-native variant of ServUO's AddBuffPacket.
// The classic packet carries cliloc ids for the buff's tooltip text; we
// instead send short ASCII name/kind strings so the client can render a
// readable HUD badge without having to ship the cliloc table.
//
// Layout (variable length):
//   u8   0xDF
//   u16  length
//   u8   action        (0 = remove, 1 = add/refresh)
//   u32  serial        (mobile this effect applies to)
//   u8   nameLen
//   asciiFixed(nameLen) name    (e.g. 'poison', 'bless')
//   u8   kindLen
//   asciiFixed(kindLen) kind    ('buff' | 'debuff')
//   u32  remainingMs   (0 on remove)

import { PacketWriter } from '../buffer.js';

const ACTION_REMOVE = 0;
const ACTION_ADD    = 1;

/**
 * @param {Object} p
 * @param {number} p.serial
 * @param {string} p.name
 * @param {'buff'|'debuff'} [p.kind='buff']
 * @param {number} [p.remainingMs=0]
 */
export function buffAdd({ serial, name, kind = 'buff', remainingMs = 0 }) {
  return build(ACTION_ADD, serial, name, kind, remainingMs);
}

/** @param {Object} p @param {number} p.serial @param {string} p.name */
export function buffRemove({ serial, name }) {
  return build(ACTION_REMOVE, serial, name, '', 0);
}

function build(action, serial, name, kind, remainingMs) {
  const nameBytes = (name ?? '').slice(0, 32);
  const kindBytes = (kind ?? '').slice(0, 16);
  // op(1) + len(2) + action(1) + serial(4) + nameLen(1) + name + kindLen(1) + kind + remaining(4)
  const size = 14 + nameBytes.length + kindBytes.length;
  const w = new PacketWriter(size);
  w.writeU8(0xDF);
  w.writeU16(size);
  w.writeU8(action & 0xff);
  w.writeU32(serial >>> 0);
  w.writeU8(nameBytes.length);
  w.writeAsciiFixed(nameBytes, nameBytes.length);
  w.writeU8(kindBytes.length);
  w.writeAsciiFixed(kindBytes, kindBytes.length);
  w.writeU32(Math.max(0, remainingMs | 0));
  return w.bytes();
}
