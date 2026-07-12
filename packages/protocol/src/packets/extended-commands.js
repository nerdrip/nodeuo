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

// Private NodeUO extension namespace. It is used only after the WebSocket
// transport selected `nodeuo.v1`; TCP/OSI/ServUO sessions never see it.
// Keeping one negotiated envelope avoids scattering unversioned custom
// subcommands throughout the protocol.
export const NODEUO_EXT_SUBCOMMAND = 0xF100;
export const NODEUO_MOVEMENT_SUBCOMMAND = 0xF101;
export const NODEUO_SPELL_COMPOSER_SUBCOMMAND = 0xF102;
export const NODEUO_SPECIALIZATION_SUBCOMMAND = 0xF103;
export const NODEUO_COOLDOWN_SUBCOMMAND = 0xF104;
export const NODEUO_NAVAL_SUBCOMMAND = 0xF105;
export const NODEUO_HOUSE_TOOLS_SUBCOMMAND = 0xF106;
export const NODEUO_PROTOCOL_MAJOR = 1;
export const NODEUO_PROTOCOL_MINOR = 0;
export const NodeUOCapability = Object.freeze({
  RichGumps:       1 << 0,
  SpawnPalette:    1 << 1,
  SpellComposer:   1 << 2,
  LiveInspector:   1 << 3,
  MovementHints:   1 << 4,
  VisualEffects:   1 << 5,
  WorldEditing:    1 << 6,
  Specializations: 1 << 7,
  CooldownBars:     1 << 8,
  NavalPreview:     1 << 9,
  HouseTools:       1 << 10,
});
export const NODEUO_CAPABILITIES_ALL = Object.values(NodeUOCapability)
  .reduce((mask, flag) => (mask | flag) >>> 0, 0);
// Advertise only features with a working end-to-end consumer.
export const NODEUO_CAPABILITIES_CURRENT = NODEUO_CAPABILITIES_ALL;

export const NodeUOCapabilityMessage = Object.freeze({ Offer: 1, Accept: 2 });
export const NodeUOSpellComposerMessage = Object.freeze({ Open: 1, Save: 2, Result: 3, Publish: 4 });
export const NodeUOSpecializationMessage = Object.freeze({ Open: 1, Allocate: 2, Result: 3, Reset: 4 });
export const NodeUOCooldownMessage = Object.freeze({ Start: 1, Remove: 2, Snapshot: 3 });
export const NodeUONavalMessage = Object.freeze({ ShowRange: 1, HideRange: 2 });
export const NodeUOHouseToolsMessage = Object.freeze({
  Snapshot: 1, Undo: 2, Redo: 3, Validate: 4,
  Copy: 5, Paste: 6, SaveTemplate: 7, ApplyTemplate: 8, Result: 9,
});

/**
 * 0xBF 0xF100 NodeUO capability negotiation.
 *
 * Layout after the extended header:
 *   u8 kind (1=server offer, 2=client accept)
 *   u8 protocol major
 *   u8 protocol minor
 *   u8 reserved
 *   u32 capability mask
 */
export function extNodeUOCapabilities({
  kind = NodeUOCapabilityMessage.Offer,
  major = NODEUO_PROTOCOL_MAJOR,
  minor = NODEUO_PROTOCOL_MINOR,
  capabilities = NODEUO_CAPABILITIES_CURRENT,
} = {}) {
  const ctx = beginExtended(NODEUO_EXT_SUBCOMMAND, 13);
  ctx.w.writeU8(kind & 0xff);
  ctx.w.writeU8(major & 0xff);
  ctx.w.writeU8(minor & 0xff);
  ctx.w.writeU8(0);
  ctx.w.writeU32(capabilities >>> 0);
  return finishExtended(ctx);
}

/** Negotiated encumbrance/pacing hint (requires MovementHints). */
export function extNodeUOMovementHint({
  weight = 0, capacity = 0, paceMultiplier = 1, staminaCost = 0, overloaded = false,
} = {}) {
  const ctx = beginExtended(NODEUO_MOVEMENT_SUBCOMMAND, 13);
  ctx.w.writeU16(Math.max(0, Math.min(0xffff, weight | 0)));
  ctx.w.writeU16(Math.max(0, Math.min(0xffff, capacity | 0)));
  ctx.w.writeU16(Math.max(1000, Math.min(4000, Math.round(paceMultiplier * 1000))));
  ctx.w.writeU8(Math.max(0, Math.min(0xff, staminaCost | 0)));
  ctx.w.writeU8(overloaded ? 1 : 0);
  return finishExtended(ctx);
}

/**
 * Private visual spell-composer message (requires SpellComposer).
 * The JSON payload is editor metadata/draft data, never executable code.
 * Layout: u8 kind, u32 requestId, u16 utf8Length, utf8 JSON.
 */
export function extNodeUOSpellComposer({
  kind = NodeUOSpellComposerMessage.Open, requestId = 0, payload = {},
} = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  if (bytes.length > 32 * 1024) throw new RangeError('Spell composer payload exceeds 32 KiB');
  const ctx = beginExtended(NODEUO_SPELL_COMPOSER_SUBCOMMAND, 12 + bytes.length);
  ctx.w.writeU8(kind & 0xff);
  ctx.w.writeU32(requestId >>> 0);
  ctx.w.writeU16(bytes.length);
  ctx.w.writeBytes(bytes);
  return finishExtended(ctx);
}

/**
 * Private visual specialization-tree message (requires Specializations).
 * The server remains authoritative: the client only requests allocation
 * and receives a fresh snapshot after every mutation.
 * Layout: u8 kind, u32 requestId, u16 utf8Length, utf8 JSON.
 */
export function extNodeUOSpecialization({
  kind = NodeUOSpecializationMessage.Open, requestId = 0, payload = {},
} = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  if (bytes.length > 32 * 1024) throw new RangeError('Specialization payload exceeds 32 KiB');
  const ctx = beginExtended(NODEUO_SPECIALIZATION_SUBCOMMAND, 12 + bytes.length);
  ctx.w.writeU8(kind & 0xff);
  ctx.w.writeU32(requestId >>> 0);
  ctx.w.writeU16(bytes.length);
  ctx.w.writeBytes(bytes);
  return finishExtended(ctx);
}

/** Server-authoritative cooldown state for the richer NodeUO HUD. */
export function extNodeUOCooldown({
  kind = NodeUOCooldownMessage.Start, requestId = 0, payload = {},
} = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  if (bytes.length > 8 * 1024) throw new RangeError('Cooldown payload exceeds 8 KiB');
  const ctx = beginExtended(NODEUO_COOLDOWN_SUBCOMMAND, 12 + bytes.length);
  ctx.w.writeU8(kind & 0xff);
  ctx.w.writeU32(requestId >>> 0);
  ctx.w.writeU16(bytes.length);
  ctx.w.writeBytes(bytes);
  return finishExtended(ctx);
}

/** Optional web-client naval overlay. It never changes cannon targeting. */
export function extNodeUONaval({
  kind = NodeUONavalMessage.ShowRange, requestId = 0, payload = {},
} = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  if (bytes.length > 16 * 1024) throw new RangeError('Naval preview payload exceeds 16 KiB');
  const ctx = beginExtended(NODEUO_NAVAL_SUBCOMMAND, 12 + bytes.length);
  ctx.w.writeU8(kind & 0xff);
  ctx.w.writeU32(requestId >>> 0);
  ctx.w.writeU16(bytes.length);
  ctx.w.writeBytes(bytes);
  return finishExtended(ctx);
}

/** Rich house-editor operations; standard 0xD7 remains authoritative. */
export function extNodeUOHouseTools({
  kind = NodeUOHouseToolsMessage.Snapshot, requestId = 0, payload = {},
} = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  if (bytes.length > 32 * 1024) throw new RangeError('House tools payload exceeds 32 KiB');
  const ctx = beginExtended(NODEUO_HOUSE_TOOLS_SUBCOMMAND, 12 + bytes.length);
  ctx.w.writeU8(kind & 0xff);
  ctx.w.writeU32(requestId >>> 0);
  ctx.w.writeU16(bytes.length);
  ctx.w.writeBytes(bytes);
  return finishExtended(ctx);
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
 * 0xBF 0x6F BuildPreview — custom (non-OSI) hint from server to client.
 * Tells the client "the next target prompt is a build placement; show
 * a translucent ghost of itemId at the cursor while the prompt is
 * active". Sent right BEFORE the 0x6C target request that arms the
 * build cursor. Cleared automatically when target:cleared fires.
 *
 * Layout (after 0xBF len + subop):
 *   u16 itemId   — graphic to ghost (0 = clear preview)
 *   u16 hue      — optional tint (0 = none)
 *
 * @param {number} itemId
 * @param {number} [hue]
 */
export function extBuildPreview(itemId, hue = 0) {
  const ctx = beginExtended(0x6F, 4);
  ctx.w.writeU16(itemId & 0xffff);
  ctx.w.writeU16(hue    & 0xffff);
  return finishExtended(ctx);
}

/**
 * 0xBF 0x6E MapTileEdit — custom (non-OSI) push from server to client
 * announcing one or more land-tile overrides. Drives the live update
 * path for the admin Map Editor: when the operator paints + saves,
 * every nearby player gets this packet, applies the edits to their
 * landAt overlay, and re-mounts affected chunks.
 *
 * Layout (after the 0xBF len + subop):
 *   u8   facet
 *   u16  count
 *   per edit: u16 x, u16 y, u16 tileId, i8 z   = 7 bytes each
 *
 * @param {number} facet
 * @param {Array<{x:number, y:number, tileId:number, z:number}>} edits
 */
export function extMapTileEdit(facet, edits) {
  const count = Math.min(0xffff, edits.length | 0);
  const size = 1 + 2 + count * 7;
  const ctx = beginExtended(0x6E, size);
  ctx.w.writeU8(facet & 0xff);
  ctx.w.writeU16(count);
  for (let i = 0; i < count; i++) {
    const e = edits[i];
    ctx.w.writeU16((e.x | 0) & 0xffff);
    ctx.w.writeU16((e.y | 0) & 0xffff);
    ctx.w.writeU16((e.tileId | 0) & 0xffff);
    ctx.w.writeI8((e.z | 0));
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

/**
 * 0xBF 0xCC ChampionStatus — custom subcommand (FAZA BT). Real UO has no
 * dedicated champion status packet; ServUO builds a per-altar gump and
 * sends it via 0xB0. We piggyback 0xBF with a high-value subcommand the
 * vanilla client ignores so our browser client gets a tiny live update
 * stream without the gump roundtrip overhead. ASCII-only because most
 * status text is map / monster names that are pure latin.
 *
 * Wire layout (after the standard 0xBF header + subcmd):
 *   u8  active        (0 = idle, 1 = running)
 *   u8  tier
 *   u8  tiersTotal
 *   u16 killsAtTier
 *   u16 killsToAdvance
 *   u16 alive
 *   u32 bossSerial
 *   u16 bossHp
 *   u16 bossHpMax
 *   ascii name (nul-terminated, max 31 chars)
 *
 * @param {{
 *   name:string, active:boolean, tier:number, tiersTotal:number,
 *   killsAtTier:number, killsToAdvance:number, alive:number,
 *   bossSerial:number, bossHp:number, bossHpMax:number,
 * }} st
 */
export function extChampionStatus(st) {
  const ctx = beginExtended(0xCC, 64);
  ctx.w.writeU8(st.active ? 1 : 0);
  ctx.w.writeU8(st.tier | 0);
  ctx.w.writeU8(st.tiersTotal | 0);
  ctx.w.writeU16(st.killsAtTier | 0);
  ctx.w.writeU16(st.killsToAdvance | 0);
  ctx.w.writeU16(st.alive | 0);
  ctx.w.writeU32((st.bossSerial | 0) >>> 0);
  ctx.w.writeU16(st.bossHp | 0);
  ctx.w.writeU16(st.bossHpMax | 0);
  ctx.w.writeAsciiNull(String(st.name ?? '').slice(0, 31));
  return finishExtended(ctx);
}

/**
 * 0xBF 0xCD VirtueState — custom subcommand (FAZA DC).
 *
 * Real UO has no virtue update wire packet — virtues live in the
 * client-side characters DB and ServUO syncs them via the OPL header
 * pushed on character entry. We sidestep all of that with a tiny
 * 8 × u32 push: one entry per canonical virtue in fixed order. Browser
 * client mirrors `mob.virtues` from this; the vanilla classic client
 * harmlessly drops 0xBF subcmds it doesn't recognise.
 *
 * Order matches `apps/server/src/systems/virtues.js` VIRTUES export
 * (humility, sacrifice, compassion, spirituality, valor, honor,
 * justice, honesty).
 *
 * @param {{
 *   humility?: number, sacrifice?: number, compassion?: number,
 *   spirituality?: number, valor?: number, honor?: number,
 *   justice?: number, honesty?: number,
 * }} v
 */
export function extVirtueState(v) {
  const ctx = beginExtended(0xCD, 36);
  ctx.w.writeU32((v.humility     | 0) >>> 0);
  ctx.w.writeU32((v.sacrifice    | 0) >>> 0);
  ctx.w.writeU32((v.compassion   | 0) >>> 0);
  ctx.w.writeU32((v.spirituality | 0) >>> 0);
  ctx.w.writeU32((v.valor        | 0) >>> 0);
  ctx.w.writeU32((v.honor        | 0) >>> 0);
  ctx.w.writeU32((v.justice      | 0) >>> 0);
  ctx.w.writeU32((v.honesty      | 0) >>> 0);
  return finishExtended(ctx);
}
