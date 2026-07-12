// Canonical UO 0xDF BuffInfo packet (ServUO AddBuffPacket/RemoveBuffPacket).
// This packet is part of the standard protocol and must never carry a
// NodeUO-specific layout: desktop clients frame it by its u16 length.

import { PacketWriter } from '../buffer.js';

const ACTION_REMOVE = 0;
const ACTION_ADD = 1;
const PLAIN_STRING_CLILOC = 1042971;

function writeUnicode(w, value) {
  const text = String(value ?? '').slice(0, 128);
  w.writeU16(text.length);
  for (let i = 0; i < text.length; i++) w.writeU16(text.charCodeAt(i));
}

/**
 * @param {Object} p
 * @param {number} p.serial
 * @param {number} p.icon standard BuffIcon enum value
 * @param {number} [p.duration] seconds
 * @param {number} [p.remainingMs] compatibility input converted to seconds
 * @param {string} [p.name] plain title passed through cliloc 1042971
 * @param {string} [p.kind] plain secondary description
 */
export function buffAdd({
  serial, icon = 0x3E9, duration, remainingMs = 0,
  name = 'Status effect', kind = 'buff',
  titleCliloc = PLAIN_STRING_CLILOC,
  secondaryCliloc = PLAIN_STRING_CLILOC,
} = {}) {
  const seconds = Math.max(0, Math.min(0xffff,
    duration == null ? Math.ceil((remainingMs | 0) / 1000) : duration | 0));
  const title = String(name ?? '').slice(0, 128);
  const secondary = String(kind ?? '').slice(0, 128);
  const size = 34 + title.length * 2 + secondary.length * 2;
  const w = new PacketWriter(size);
  w.writeU8(0xDF);
  w.writeU16(size);
  w.writeU32(serial >>> 0);
  w.writeU16(icon & 0xffff);
  w.writeU16(ACTION_ADD);
  w.writeU16(0);
  w.writeU16(seconds);
  w.writeU8(0); w.writeU8(0); w.writeU8(0);
  w.writeU32(titleCliloc >>> 0);
  w.writeU32(secondaryCliloc >>> 0);
  w.writeU32(0);
  writeUnicode(w, title);
  writeUnicode(w, secondary);
  return w.bytes();
}

/** @param {{serial:number,icon?:number}} p */
export function buffRemove({ serial, icon = 0x3E9 } = {}) {
  const w = new PacketWriter(11);
  w.writeU8(0xDF);
  w.writeU16(11);
  w.writeU32(serial >>> 0);
  w.writeU16(icon & 0xffff);
  w.writeU16(ACTION_REMOVE);
  return w.bytes();
}
