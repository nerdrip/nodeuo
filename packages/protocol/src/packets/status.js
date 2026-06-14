// Health / status packets.
//
// - 0xA1 HealthUpdate: current/max HP for any mobile.
// - 0xA2 ManaUpdate: current/max mana.
// - 0xA3 StaminaUpdate: current/max stamina.
// - 0x11 MobileStatus: full status window (name, stats, gold, weight...).
//
// ServUO refs: Server/Network/Packets.cs — `HealthbarPoison`, `MobileStatus`,
// `ManaStatus`, `HealthUpdate`.

import { PacketWriter } from '../buffer.js';

/** 0xA1 — 9 bytes. */
export function healthUpdate({ serial, current, max }) {
  const w = new PacketWriter(9);
  w.writeU8(0xA1);
  w.writeU32(serial);
  w.writeU16(max & 0xFFFF);
  w.writeU16(current & 0xFFFF);
  return w.bytes();
}

/** 0xA2 — 9 bytes. */
export function manaUpdate({ serial, current, max }) {
  const w = new PacketWriter(9);
  w.writeU8(0xA2);
  w.writeU32(serial);
  w.writeU16(max & 0xFFFF);
  w.writeU16(current & 0xFFFF);
  return w.bytes();
}

/** 0xA3 — 9 bytes. */
export function staminaUpdate({ serial, current, max }) {
  const w = new PacketWriter(9);
  w.writeU8(0xA3);
  w.writeU32(serial);
  w.writeU16(max & 0xFFFF);
  w.writeU16(current & 0xFFFF);
  return w.bytes();
}

/**
 * 0x11 MobileStatus — basic (type=0x01) status window. Variable length.
 *
 * We emit the classic (pre-AoS) layout, which the 7.0.x client accepts for
 * initial display. Extended types (race, resistances, etc.) are deferred.
 *
 * @param {Object} p
 * @param {number} p.serial
 * @param {string} p.name            30 chars ASCII
 * @param {number} p.hp
 * @param {number} p.hpMax
 * @param {boolean} [p.canRename]
 * @param {number} [p.sex]           0 = male, 1 = female
 * @param {number} [p.str]
 * @param {number} [p.dex]
 * @param {number} [p.int]
 * @param {number} [p.stam]
 * @param {number} [p.stamMax]
 * @param {number} [p.mana]
 * @param {number} [p.manaMax]
 * @param {number} [p.gold]
 * @param {number} [p.ar]
 * @param {number} [p.weight]
 * @param {number} [p.statCap]
 * @param {number} [p.followers]
 * @param {number} [p.followersMax]
 */
export function mobileStatus({
  serial, name, hp, hpMax,
  canRename = false,
  sex = 0,
  str = 50, dex = 50, int: intel = 50,
  stam = 50, stamMax = 50,
  mana = 50, manaMax = 50,
  gold = 0, ar = 0, weight = 0,
  weightMax = 0, race = 1,
  statCap = 225, followers = 0, followersMax = 5,
  // v5 fields — resists + luck + damage range + tithing.
  fireResist = 0, coldResist = 0, poisonResist = 0, energyResist = 0,
  luck = 0, dmgMin = 0, dmgMax = 0, tithingPoints = 0,
  // BUGFIX #54 (FAZA CL): version gates how much we serialise. Version
  // 0x00 = "brief" (name + HP + hpMax + canRename only) — what ServUO
  // ships to non-self status requests. Version 0x05 (default) keeps the
  // full classic-AOS layout INCLUDING resists / luck / damage range /
  // tithing — without these the status gump's resist/luck/dmg slots
  // stay '-' forever (client decoder gates on version >= 0x05).
  version = 0x05,
}) {
  // 73 bytes for v4 (43 base + 23 v3 + 7 v4); allocate generous + trim.
  const w = new PacketWriter(80);
  w.writeU8(0x11);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial);
  w.writeAsciiFixed(name ?? '', 30);
  w.writeU16(hp & 0xFFFF);
  w.writeU16(hpMax & 0xFFFF);
  w.writeU8(canRename ? 1 : 0);
  w.writeU8(version & 0xff);
  if ((version & 0xff) >= 0x01) {
    w.writeU8(sex & 0xff);
    w.writeU16(str & 0xFFFF);
    w.writeU16(dex & 0xFFFF);
    w.writeU16(intel & 0xFFFF);
    w.writeU16(stam & 0xFFFF);
    w.writeU16(stamMax & 0xFFFF);
    w.writeU16(mana & 0xFFFF);
    w.writeU16(manaMax & 0xFFFF);
    w.writeU32(gold >>> 0);
    w.writeU16(ar & 0xFFFF);
    w.writeU16(weight & 0xFFFF);
  }
  if ((version & 0xff) >= 0x04) {
    // CUO/ServUO canonical v4 layout: weightMax + race come BEFORE statCap.
    // Omitting them caused the client decoder to read statCap from the
    // statCap-byte position offset by -3, producing the "need 2, have 1"
    // RangeError at PacketReader._check.
    w.writeU16(weightMax & 0xFFFF);
    w.writeU8(race & 0xff);
    w.writeU16(statCap & 0xFFFF);
    w.writeU8(followers & 0xff);
    w.writeU8(followersMax & 0xff);
  }
  if ((version & 0xff) >= 0x05) {
    w.writeU16(fireResist   & 0xFFFF);
    w.writeU16(coldResist   & 0xFFFF);
    w.writeU16(poisonResist & 0xFFFF);
    w.writeU16(energyResist & 0xFFFF);
    w.writeU16(luck         & 0xFFFF);
    w.writeU16(dmgMin       & 0xFFFF);
    w.writeU16(dmgMax       & 0xFFFF);
    w.writeU32(tithingPoints >>> 0);
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
