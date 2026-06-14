// Combat atoms — the wire primitives that must exist before any real combat
// layer (which is deferred past v1).
//
//   0x72 RequestWarMode (C<->S): 5 bytes: u8, u8 mode(0/1), u8 0, u8 0x32, u8 0
//   0x6E PlayerAnimation (S->C): 14 bytes: u8, u32 serial, u16 action, u16 frameCount,
//                                u16 repeatCount, u8 reverse, u8 repeat, u8 delay
//   0x0B Damage (S->C): 7 bytes: u8, u32 serial, u16 amount
//   0xE2 NewPlayerAnimation (S->C): 10 bytes: u8, u32 serial, u16 action, u16 subAction, u8 type

import { PacketWriter } from '../buffer.js';

/**
 * 0x72 Warmode — 5 bytes.
 * @param {boolean} warmode
 */
export function warmode(warmode) {
  const w = new PacketWriter(5);
  w.writeU8(0x72);
  w.writeU8(warmode ? 1 : 0);
  w.writeU8(0);
  w.writeU8(0x32);
  w.writeU8(0);
  return w.bytes();
}

/**
 * Parse a 0x72 warmode toggle request from the client.
 * @param {Uint8Array} pkt
 */
export function readWarmode(pkt) {
  if (pkt[0] !== 0x72) throw new Error('not a 0x72 warmode');
  return { warmode: pkt[1] !== 0 };
}

/**
 * 0x6E PlayerAnimation — 14 bytes fixed.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {number} p.action       animation action id (see action table)
 * @param {number} [p.frameCount] number of frames (default 5)
 * @param {number} [p.repeatCount]
 * @param {boolean} [p.reverse]
 * @param {boolean} [p.repeat]
 * @param {number} [p.delay]
 */
export function playerAnimation({ serial, action, frameCount = 7, repeatCount = 1,
                                  reverse = false, repeat = false, delay = 0 }) {
  const w = new PacketWriter(14);
  w.writeU8(0x6E);
  w.writeU32(serial >>> 0);
  w.writeU16(action & 0xFFFF);
  w.writeU16(frameCount & 0xFFFF);
  w.writeU16(repeatCount & 0xFFFF);
  w.writeU8(reverse ? 1 : 0);
  w.writeU8(repeat ? 1 : 0);
  w.writeU8(delay & 0xff);
  return w.bytes();
}

/**
 * 0xE2 NewPlayerAnimation (SA).
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {number} p.action
 * @param {number} [p.subAction]
 * @param {number} [p.type]
 */
export function newPlayerAnimation({ serial, action, subAction = 0, type = 0 }) {
  const w = new PacketWriter(10);
  w.writeU8(0xE2);
  w.writeU32(serial >>> 0);
  w.writeU16(action & 0xFFFF);
  w.writeU16(subAction & 0xFFFF);
  w.writeU8(type & 0xff);
  return w.bytes();
}

/**
 * 0x0B Damage — 7 bytes.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {number} p.amount
 */
export function damagePacket({ serial, amount }) {
  const w = new PacketWriter(7);
  w.writeU8(0x0B);
  w.writeU32(serial >>> 0);
  w.writeU16(amount & 0xFFFF);
  return w.bytes();
}

/**
 * 0x2C Death status / resurrection menu — 2 bytes.
 * action: 0x00 = die (show death screen), 0x02 = resurrect (close it).
 *
 * @param {number} action
 */
export function deathStatus(action = 0) {
  const w = new PacketWriter(2);
  w.writeU8(0x2C);
  w.writeU8(action & 0xff);
  return w.bytes();
}

/**
 * 0xAF DisplayDeathAction — 13 bytes. Server tells the client a mobile
 * has died. Carries the dying mobile's serial, the spawned corpse's
 * serial, and a `running` flag (so the client picks the right "fall
 * forward" vs "fall backward" anim group). The client uses this to
 * register the corpse with its CorpseManager (which stamps facing on
 * the corpse's `Item.layer`) and to play the Die1/Die2 one-shot.
 *
 * Without this packet the client never plays the fall animation and
 * the corpse Item has no facing → renders at default direction.
 *
 * @param {Object} p
 * @param {number} p.serial         dying mobile serial
 * @param {number} p.corpseSerial   spawned corpse Item serial
 * @param {boolean} [p.running=false] true when the mob was running
 */
export function deathAction({ serial, corpseSerial, running = false }) {
  const w = new PacketWriter(13);
  w.writeU8(0xAF);
  w.writeU32(serial >>> 0);
  w.writeU32(corpseSerial >>> 0);
  w.writeU32(running ? 1 : 0);
  return w.bytes();
}

/** Standard animation actions (abridged — see ServUO `AnimationType.cs`). */
export const Anim = Object.freeze({
  Walk: 0x00,
  WalkArmed: 0x01,
  Run: 0x02,
  RunArmed: 0x03,
  Idle: 0x04,
  Attack1H: 0x09,
  Attack2HSlash: 0x0C,
  Bow: 0x12,
  AttackUnarmed: 0x1F,
  CastDirected: 0x10,
  CastAreaEffect: 0x11,
  TakeHit: 0x14,
  Die: 0x15,
  Bow_Emote: 0x20,
  Salute: 0x21,
});
