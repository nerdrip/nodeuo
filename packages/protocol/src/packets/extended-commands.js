// 0xBF Extended Command — a multiplexed opcode used for dozens of sub-packets
// keyed by a 2-byte subcommand. ServUO: `Server/Network/PacketHandlers.cs`
// and many files in `Server/Network/ExtendedPackets/`.
//
// This module hosts a handful of commonly used sub-commands needed to bring
// a client to a playable state (map change, party state, etc). More
// subcommands get added as the server needs them.

import { PacketWriter } from '../buffer.js';

/**
 * Internal helper: write the 0xBF header with the given subcommand and let
 * the caller fill in the rest, then patch the length.
 *
 * @param {number} subCmd
 * @param {number} [initialCap]
 */
function beginExtended(subCmd, initialCap = 16) {
  const w = new PacketWriter(initialCap);
  w.writeU8(0xBF);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU16(subCmd);
  return { w, lenPos };
}

function finishExtended({ w, lenPos }) {
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * 0x15 CharacterLocale — fixed 9-byte packet pushed once at login that
 * tells the client what game-time locale (calendar/region) the avatar
 * is in. Used by ServUO for AOS clilocs and date displays. Layout:
 *   u8  0x15
 *   u32 serial
 *   u32 localeId   (1 = Britannia / vanilla)
 */
export function characterLocale(serial, localeId = 1) {
  const w = new PacketWriter(9);
  w.writeU8(0x15);
  w.writeU32(serial >>> 0);
  w.writeU32(localeId >>> 0);
  return w.bytes();
}

/**
 * 0xBF 0x08 MapChange — tells the client to load a different facet.
 * @param {number} mapId  0 = Felucca, 1 = Trammel, ...
 */
export function extMapChange(mapId) {
  const ctx = beginExtended(0x08);
  ctx.w.writeU8(mapId & 0xff);
  return finishExtended(ctx);
}

/**
 * 0xBF 0x18 MapPatches — the client expects one entry per facet declaring
 * whether a patched block table exists. For a vanilla server we send zeros:
 * no static or map patches.
 */
export function extMapPatches() {
  const ctx = beginExtended(0x18, 32);
  ctx.w.writeU32(4); // facets (ServUO sends 4)
  for (let i = 0; i < 4; i++) {
    ctx.w.writeU32(0); // staticsBlockCount
    ctx.w.writeU32(0); // mapBlockCount
  }
  return finishExtended(ctx);
}

/**
 * 0xBF 0x04 CloseStatusGump — close a context menu.
 * @param {number} serial
 */
export function extCloseStatusGump(serial) {
  const ctx = beginExtended(0x04);
  ctx.w.writeU32(serial);
  return finishExtended(ctx);
}

/**
 * 0xBF 0x19 SetStatLock — set a stat lock display.
 * (Mostly used by client->server; emitted here for completeness.)
 */
export function extExtendedStats(serial, strLock, dexLock, intLock) {
  const ctx = beginExtended(0x19, 12);
  ctx.w.writeU8(2);
  ctx.w.writeU32(serial);
  ctx.w.writeU8(0);
  ctx.w.writeU8(((strLock & 3) << 4) | ((dexLock & 3) << 2) | (intLock & 3));
  return finishExtended(ctx);
}

/**
 * 0xBF 0x20 CustomHouseInteraction.
 * Types 4 and 5 enter/leave design mode; types 1..3 update pieces/position.
 */
export function extHouseCustomization({
  serial, type, graphic = 0, x = 0, y = 0, z = 0,
}) {
  const ctx = beginExtended(0x20, 17);
  ctx.w.writeU32(serial >>> 0);
  ctx.w.writeU8(type & 0xff);
  ctx.w.writeU16(graphic & 0xffff);
  ctx.w.writeU16(x & 0xffff);
  ctx.w.writeU16(y & 0xffff);
  ctx.w.writeI8(z | 0);
  return finishExtended(ctx);
}

/** 0xBF 0x1D DesignStateGeneral — advertises a custom-house revision. */
export function extHouseRevision({ serial, revision = 0 }) {
  const ctx = beginExtended(0x1D, 13);
  ctx.w.writeU32(serial >>> 0);
  ctx.w.writeU32(revision >>> 0);
  return finishExtended(ctx);
}

/**
 * 0xBF 0x1B NewSpellbookContent — declares a spellbook's contents.
 *
 * ServUO: `Server/Network/ExtendedPackets/NewSpellbookContent.cs`. The
 * `offset` field identifies the first spell id in the book (1 for Magery,
 * 101 for Necromancy, 201 for Chivalry, etc.). Each of the 64 bits in
 * `content` flags whether that spell is known (bit 0 = spell at `offset`).
 *
 * @param {Object} args
 * @param {number} args.serial    spellbook item serial
 * @param {number} [args.offset]  first-spell id; defaults to 1 (Magery)
 * @param {bigint|number} args.content  64-bit spell mask (Number is widened)
 */
export function extNewSpellbookContent({ serial, offset = 1, content }) {
  const ctx = beginExtended(0x1B, 23);
  ctx.w.writeU16(1);            // unknown, always 1
  ctx.w.writeU32(serial >>> 0);
  ctx.w.writeU16(offset & 0xffff);
  // 64-bit content mask, big-endian.
  const big = typeof content === 'bigint' ? content : BigInt(content >>> 0);
  const hi = Number((big >> 32n) & 0xFFFFFFFFn);
  const lo = Number(big & 0xFFFFFFFFn);
  ctx.w.writeU32(hi);
  ctx.w.writeU32(lo);
  return finishExtended(ctx);
}
