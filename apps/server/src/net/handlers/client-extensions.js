import {
  PacketReader,
  containerContents,
  removeEntity,
  unicodeMessage,
} from '@uo/protocol';
import { setItemParent } from '../../world/items.js';
import { nearbyClients } from '../../world/visibility.js';
import { Stage } from '../net-state.js';
import { sendNodeUOFeature } from './nodeuo-modern.js';
import { customHouseDesign } from '../custom-house-packets.js';

function customHouseOrigin(state, house) {
  return state.ctx.world?.items?.get?.(house?.multiSerial >>> 0)
    ?? { x: house?.x1 | 0, y: house?.y1 | 0, z: house?.z | 0 };
}

function customWorldXY(state, house, x, y) {
  const origin = customHouseOrigin(state, house);
  return { x: (origin.x | 0) + (x | 0), y: (origin.y | 0) + (y | 0) };
}

function customWorldZ(state, house, z) {
  return (customHouseOrigin(state, house).z | 0) + (z | 0);
}

const HOUSING_SUBOPS = new Set([
  0x02, 0x03, 0x04, 0x05, 0x06, 0x0C, 0x0D, 0x0E,
  0x10, 0x12, 0x13, 0x14, 0x1A,
]);

const HOUSING_BODY_MINIMUM = new Map([
  [0x02, 1], [0x03, 1], [0x04, 1], [0x05, 21], [0x06, 16],
  [0x0C, 1], [0x0D, 16], [0x0E, 1], [0x10, 1], [0x12, 6],
  [0x13, 21], [0x14, 21], [0x1A, 1],
]);

export function sendHouseDesignDetails(state, house, { response = true } = {}) {
  if (!state || !house) return false;
  const ownDraft = house.editing?.editorSerial === (state.mobile?.serial >>> 0);
  const tiles = ownDraft
    ? house.editing.tiles
    : (house.tiles ?? []).filter((tile) => tile.kind !== 'door' && tile.kind !== 'teleport');
  const revision = ownDraft ? house.editing.revision : house.revision;
  try {
    state.send(customHouseDesign({
      serial: house.multiSerial ?? house.id,
      revision: revision | 0,
      response,
      origin: customHouseOrigin(state, house),
      tiles,
    }));
    return true;
  } catch (error) {
    console.warn(`[housing] could not encode design #${house.id}: ${error.message}`);
    return false;
  }
}

export function handleHouseDesignRequest(state, serial) {
  if (state.stage !== Stage.InWorld || !state.mobile) return false;
  const houses = state.ctx.houses ?? state.ctx.systems?.houses;
  const house = houses?.houseByMultiSerial?.(serial) ?? null;
  if (!house || house.map !== state.mobile.map) return false;
  const origin = customHouseOrigin(state, house);
  const range = Math.max(18, state.viewRange | 0);
  if (Math.max(Math.abs((state.mobile.x | 0) - (origin.x | 0)),
    Math.abs((state.mobile.y | 0) - (origin.y | 0))) > range) return false;
  return sendHouseDesignDetails(state, house, { response: true });
}

// ---------------------------------------------------------------------------
// 0x95 HuePickerResponse — fixed 9B (op + dialogId u32 + itemId u16 + hue u16)
//
// Client picks a hue from a hue-picker dialog the server pushed via outbound
// 0x95. We look up the pending picker by `dialogId`, validate ownership, and
// invoke its callback. Dialogs that go unanswered for >60s are pruned in
// `cleanupHuePickers`.
// ---------------------------------------------------------------------------

export function handleHuePickerResponse(state, pkt) {
  if (state.stage !== Stage.InWorld) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const dialogId = r.readU32();
  const itemId   = r.readU16();
  const hue      = r.readU16();
  const ctx = state.ctx;
  const pending = ctx?._huePickers?.get(dialogId);
  if (!pending || pending.serial !== (state.mobile?.serial >>> 0)) return;
  ctx._huePickers.delete(dialogId);
  try { pending.callback?.(hue & 0x3FFF, itemId); }
  catch (e) { console.warn('[net] hue picker callback threw:', e?.message); }
}

// ---------------------------------------------------------------------------
// 0x98 MobileNameRequest — variable. Inbound: op + len + serial (7B).
// Outbound: op + len + serial + name padded to 30 chars (37B).
//
// Older clients fall back to this when OPL (0xD6) is unavailable. We honour
// it for parity but expect 0xD6 to handle the bulk of name display.
// ---------------------------------------------------------------------------

export function handleMobileNameRequest(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.ctx?.world) return;
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();
  const serial = r.readU32();
  const target = state.ctx.world.mobiles.get(serial) ?? state.ctx.world.items.get(serial);
  if (!target) return;
  const name = String(target.name ?? '').slice(0, 29);
  // Build response: 0x98 + len(2) + serial(4) + name(30, ASCII null-padded)
  const buf = new Uint8Array(7 + 30);
  buf[0] = 0x98;
  buf[1] = 0x00; buf[2] = 0x25;  // length = 37
  buf[3] = (serial >>> 24) & 0xff;
  buf[4] = (serial >>> 16) & 0xff;
  buf[5] = (serial >>>  8) & 0xff;
  buf[6] =  serial         & 0xff;
  for (let i = 0; i < name.length; i++) buf[7 + i] = name.charCodeAt(i) & 0x7f;
  state.send(buf);
}

// ---------------------------------------------------------------------------
// 0x9A AsciiPromptResponse — variable. Older clients answer prompts in ASCII
// rather than the 0xC2 unicode form. Format: op + len(2) + senderSerial(4)
// + promptId(4) + type(4) + asciiNul.
// ---------------------------------------------------------------------------

export function handleAsciiPromptResponse(state, pkt) {
  if (state.stage !== Stage.InWorld) return;
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();
  const senderSerial = r.readU32();
  const promptId     = r.readU32();
  const type         = r.readU32();
  let text = '';
  while (r.remaining > 0) {
    const c = r.readU8();
    if (!c) break;
    text += String.fromCharCode(c);
    if (text.length > 256) break;
  }
  const ctx = state.ctx;
  const pending = ctx?._prompts?.get(promptId);
  if (!pending || pending.serial !== (state.mobile?.serial >>> 0)) return;
  ctx._prompts.delete(promptId);
  try { pending.callback?.(type === 0 ? null : text, senderSerial >>> 0); }
  catch (e) { console.warn('[net] ascii prompt callback threw:', e?.message); }
}

// ---------------------------------------------------------------------------
// 0x9D GMSingle — fixed 51B GM-only command. ServUO routes these through a
// privileged path; we accept it only when the player has admin access.
// ---------------------------------------------------------------------------

export function handleGMSingle(state /* , pkt */) {
  if (state.stage !== Stage.InWorld || !state.mobile?.isAdmin) return;
  // Body is documented as a packed (CommandType, args) blob with no fixed
  // schema across client builds. Ignore the payload — admins use [commands.
}

// ---------------------------------------------------------------------------
// 0xB6 ObjectHelpRequest — fixed 9B (op + serial + reqType).
// Older clients ask for "help" text on right-click; modern flow uses 0xD6.
// We respond with a 0xB7 ObjectHelpResponse pointing to a generic message.
// ---------------------------------------------------------------------------

export function handleObjectHelpRequest(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.ctx?.world) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const target = state.ctx.world.mobiles.get(serial) ?? state.ctx.world.items.get(serial);
  if (!target) return;
  // ServUO's "help" text on objects is the same as single-click name —
  // mirror that and rely on OPL for richer info.
  state.send(unicodeMessage({
    serial: serial >>> 0,
    graphic: 0xFFFF, type: 6, hue: 0x03B2, font: 3,
    name: '', text: String(target.name ?? '?'),
  }));
}

// ---------------------------------------------------------------------------
// 0xC8 SetUpdateRange — 2B (op + range, 5..18). Modern clients tell the
// server how far they want updates broadcast. We persist the value on the
// netState so visibility can clamp loops to it (saves bandwidth on small
// viewports).
// ---------------------------------------------------------------------------

export function handleClientViewRange(state, pkt) {
  if (state.stage !== Stage.InWorld) return;
  const range = pkt[1] | 0;
  state.viewRange = Math.max(5, Math.min(18, range || 18));
}

// ---------------------------------------------------------------------------
// 0xEC EquipMacro / 0xED UnequipMacro — variable. Player triggered an
// in-game macro to equip/unequip from the paperdoll. ServUO simply forwards
// to the wear/unwear pipeline.
// ---------------------------------------------------------------------------

export function handleEquipMacro(state, pkt, handleWearItem) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();
  const count = r.readU8();
  const serials = [];
  for (let i = 0; i < count; i++) serials.push(r.readU32());
  if (!state.ctx?.world) return;
  for (const serial of serials) {
    const item = state.ctx.world.items.get(serial >>> 0);
    if (!item) continue;
    if (item.parent !== state.mobile.serial) continue;  // must come from backpack
    // Reuse existing wear pipeline by faking a 0x13 wear request.
    const layer = item.layer | 0;
    if (!layer) continue;
    try {
      const fakePkt = new Uint8Array(10);
      fakePkt[0] = 0x13;
      fakePkt[1] = (serial >>> 24) & 0xff;
      fakePkt[2] = (serial >>> 16) & 0xff;
      fakePkt[3] = (serial >>>  8) & 0xff;
      fakePkt[4] =  serial         & 0xff;
      fakePkt[5] = layer & 0xff;
      const target = state.mobile.serial >>> 0;
      fakePkt[6] = (target >>> 24) & 0xff;
      fakePkt[7] = (target >>> 16) & 0xff;
      fakePkt[8] = (target >>>  8) & 0xff;
      fakePkt[9] =  target         & 0xff;
      handleWearItem(state, fakePkt);
    } catch (e) {
      console.warn('[net] equip-macro item failed:', e?.message);
    }
  }
}

export function handleUnequipMacro(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();
  const count = r.readU8();
  const layers = [];
  for (let i = 0; i < count; i++) layers.push(r.readU8());
  if (!state.ctx?.world) return;
  // Move each requested layer from paperdoll → backpack via the same path
  // dragDrop uses for "lift from equip slot".
  const backpack = state.ctx.world.items.get(state.mobile.backpack >>> 0);
  if (!backpack) return;
  for (const layer of layers) {
    for (const item of state.ctx.world.items.values()) {
      if (item.parent !== state.mobile.serial) continue;
      if ((item.layer | 0) !== layer) continue;
      // Move to backpack (simple bounce: change parent + position).
      setItemParent(state.ctx.world, item, backpack.serial);
      item.x = (Math.random() * 80) | 0;
      item.y = (Math.random() * 80) | 0;
      item.layer = 0;
      // Broadcast removal from paperdoll + update container.
      try {
        for (const c of nearbyClients(state.ctx.world, state.mobile)) {
          c.client.send(removeEntity(item.serial));
        }
        state.send(containerContents([item], { containerSerial: backpack.serial }));
      } catch { /* ignore broadcast errors */ }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// 0xD7 House Customization — port of CUO `OutgoingPackets.Send_CustomHouse*`.
//
// Layout (variable-length):
//   u8  op (0xD7)
//   u16 length
//   u32 playerSerial
//   u16 subop
//   ...subop body — most subops use u8 0x00 separators between u32 fields
//   u8  0x0A terminator
//
// Subops we honour (server side):
//   0x02 Backup       — snapshot editing.tiles
//   0x03 Restore      — apply backup
//   0x04 Commit       — promote editing → committed
//   0x05 DeleteItem   — remove (g, x, y, z)
//   0x06 AddItem      — add (g, x, y)
//   0x0C Exit         — leave edit mode without committing
//   0x0D AddStair     — add (g, x, y) tagged stair
//   0x0E Sync         — re-emit revision to client
//   0x10 Clear        — drop every editing tile
//   0x12 GoToFloor    — change current floor
//   0x13 AddRoof      — add (g, x, y, z) tagged roof
//   0x14 DeleteRoof   — remove (g, x, y, z) tagged roof
//   0x1A Revert       — drop the editing buffer
//
// We resolve the active house selected by the sign/gump, then fall back to the
// standard hinted foundation serial and finally the player's first house.
// ---------------------------------------------------------------------------

export function handleHouseCustomization(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  if (pkt.length < 9) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const declaredLength = r.readU16();
  if (declaredLength !== pkt.length) return;
  const hintedSerial = r.readU32(); // player serial on CUO; house serial on a few legacy clients
  const sub = r.readU16();

  // 0xD7 is also ServUO's generic encoded-command envelope. Resolve a house
  // only for the customization subcommands; weapon abilities, guild and quest
  // requests must keep working for characters that do not own a house.
  const houseRegistry = state.ctx.houses ?? state.ctx.systems?.houses;
  let house = null;
  if (HOUSING_SUBOPS.has(sub)) {
    if (r.remaining < (HOUSING_BODY_MINIMUM.get(sub) ?? 1)) return;
    const separatedFields = (sub === 0x05 || sub === 0x13 || sub === 0x14)
      ? 4 : (sub === 0x06 || sub === 0x0D) ? 3 : 0;
    for (let index = 0; index < separatedFields; index++) {
      if (pkt[9 + index * 5] !== 0) return;
    }
    if (!houseRegistry) return;
    house = houseRegistry.activeHouseFor?.(
      state.mobile, state._activeHouseId, hintedSerial,
    ) ?? (houseRegistry.housesOf?.(state.mobile.serial) ?? [])[0] ?? null;
    if (!house) {
      state.sendSystemMessage?.('You do not own a house to customize.');
      return;
    }
    if (!house.customizable) {
      state.sendSystemMessage?.('This classic house cannot be customized.');
      return;
    }
    const mx = state.mobile.x | 0, my = state.mobile.y | 0;
    const dx = mx < (house.x1 | 0) ? (house.x1 | 0) - mx
      : mx > (house.x2 | 0) ? mx - (house.x2 | 0) : 0;
    const dy = my < (house.y1 | 0) ? (house.y1 | 0) - my
      : my > (house.y2 | 0) ? my - (house.y2 | 0) : 0;
    if (state.mobile.map !== house.map || Math.max(dx, dy) > 3) {
      state.sendSystemMessage?.('You must remain at the house to customize it.');
      return;
    }
    if (house.editing && house.editing.editorSerial !== (state.mobile.serial >>> 0)) {
      state.sendSystemMessage?.('That house is already being edited.');
      return;
    }
  }

  const ack = (msg) => state.sendSystemMessage?.(msg);
  const richResult = (operation, ok, message, extra = {}) => {
    sendNodeUOFeature(state, {
      feature: 'housing.tools', delivery: 'reliable',
      payload: { eventKind: 0, requestId: 0, data: {
        operation, ok: !!ok, message, ...extra,
      } },
    });
  };

  // Subop body parsers — ServUO/CUO writes u8 0x00 separators before
  // each u32 to avoid reading into framing slop.
  const readSepU32 = () => { r.readU8(); return r.readU32() | 0; };
  const readSepI32 = () => { r.readU8(); return r.readI32(); };

  switch (sub) {
    case 0x02:
      if (!house.editing && !houseRegistry.beginEditing?.(house, state.mobile)) {
        ack('Could not enter house design mode.');
      } else if (houseRegistry.backupCustom?.(house)) {
        ack('House layout backed up.');
      } else {
        ack('Could not back up the house layout.');
      }
      break;
    case 0x03:
      if (houseRegistry.restoreCustom?.(house)) {
        ack('House layout restored from backup.');
        sendHouseDesignDetails(state, house);
      }
      else ack('No backup to restore.');
      break;
    case 0x04:
      if (houseRegistry.commitCustom?.(house)) {
        const message = `House layout committed (${house.tiles?.length ?? 0} tiles).`;
        ack(message);
        richResult('commit', true, message, { revision: house.revision | 0, tileCount: house.tiles?.length ?? 0 });
        const revisionPacket = state.ctx.protocol?.extHouseRevision?.({
          serial: house.multiSerial ?? house.id, revision: house.revision | 0,
        });
        const foundation = customHouseOrigin(state, house);
        if (revisionPacket) {
          for (const viewer of nearbyClients(state.ctx.world, foundation)) viewer.client?.send?.(revisionPacket);
        }
        const packet = state.ctx.protocol?.extHouseCustomization?.({
          serial: house.multiSerial ?? house.id, type: 5,
          x: -1, y: -1, z: -1,
        });
        if (packet) state.send(packet);
      } else {
        const validation = houseRegistry.validateCustom?.(house);
        const message = validation?.errors?.[0] ?? 'Not in edit mode.';
        ack(message);
        richResult('commit', false, message, { validation });
      }
      break;
    case 0x05: {
      const g = readSepU32();
      const rawX = readSepU32();
      const rawY = readSepU32();
      const rawZ = readSepI32();
      const { x, y } = customWorldXY(state, house, rawX, rawY);
      const z = customWorldZ(state, house, rawZ);
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      const removed = houseRegistry.removeCustomItem?.(house, g, x, y, z) ?? 0;
      if (!removed) ack('No matching tile to remove.');
      break;
    }
    case 0x06: {
      const g = readSepU32();
      const rawX = readSepU32();
      const rawY = readSepU32();
      const { x, y } = customWorldXY(state, house, rawX, rawY);
      // Standard 0xD7 ends here. Accept the one-byte role hint emitted by
      // short-lived pre-standard NodeUO builds, otherwise derive behavior
      // from the authoritative housedata catalogue.
      const kindCode = r.remaining >= 2 ? r.readU8() : -1;
      const kind = kindCode >= 0
        ? (['item', 'wall', 'door', 'floor', 'misc', 'teleport'][kindCode] ?? 'item')
        : houseRegistry.customPieceKind?.(g, 'item') ?? 'item';
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      const floor = Math.max(1, Math.min(4, house.editing?.floor | 0 || 1));
      if (!houseRegistry.addCustomItem?.(house, kind, g, x, y, (house.z | 0) + 7 + (floor - 1) * 20)) {
        ack('That house piece is invalid, outside the foundation, or exceeds the design limit.');
      }
      break;
    }
    case 0x0C:
      if (houseRegistry.revertCustom?.(house)) {
        ack('Exited customization without saving.');
        sendHouseDesignDetails(state, house);
        houseRegistry.setFixturesVisibleTo?.(house, state, true);
      }
      {
        const packet = state.ctx.protocol?.extHouseCustomization?.({
          serial: house.multiSerial ?? house.id, type: 5,
          x: -1, y: -1, z: -1,
        });
        if (packet) state.send(packet);
      }
      break;
    case 0x0D: {
      const g = readSepU32();
      const rawX = readSepU32();
      const rawY = readSepU32();
      const { x, y } = customWorldXY(state, house, rawX, rawY);
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      const floor = Math.max(1, Math.min(4, house.editing?.floor | 0 || 1));
      if (!houseRegistry.addCustomItem?.(house, 'stair', g, x, y, (house.z | 0) + 7 + (floor - 1) * 20)) {
        ack('That stair cannot be placed there.');
      }
      break;
    }
    case 0x0E:
      ack(`Sync — revision ${house.revision ?? 0}, tiles ${house.tiles?.length ?? 0}.`);
      sendHouseDesignDetails(state, house);
      break;
    case 0x10:
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.clearCustomTiles?.(house);
      ack('Cleared editing buffer.');
      sendHouseDesignDetails(state, house);
      break;
    case 0x12: {
      const _pad = r.readU32(); void _pad;
      const floor = r.readU8();
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.setEditingFloor?.(house, floor);
      break;
    }
    case 0x13: {
      const g = readSepU32();
      const rawX = readSepU32();
      const rawY = readSepU32();
      const rawZ = readSepI32();
      const { x, y } = customWorldXY(state, house, rawX, rawY);
      const z = customWorldZ(state, house, rawZ);
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      if (!houseRegistry.addCustomItem?.(house, 'roof', g, x, y, z)) ack('That roof piece cannot be placed there.');
      break;
    }
    case 0x14: {
      const g = readSepU32();
      const rawX = readSepU32();
      const rawY = readSepU32();
      const rawZ = readSepI32();
      const { x, y } = customWorldXY(state, house, rawX, rawY);
      const z = customWorldZ(state, house, rawZ);
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.removeCustomItem?.(house, g, x, y, z);
      break;
    }
    case 0x1A:
      if (houseRegistry.revertCustom?.(house)) {
        ack('Reverted edits.');
        sendHouseDesignDetails(state, house);
      }
      break;
    // -----------------------------------------------------------------
    // Encoded (ServUO `RegisterEncoded`) — these subops aren't house
    // related but share the 0xD7 opcode envelope. Each carries the
    // standard header (u8/u16/u32 ownerSerial/u16 subop) already
    // consumed above; only the body parsing differs.
    // -----------------------------------------------------------------
    case 0x19: {
      // SetAbility — client picks a special weapon ability into the
      // primary or secondary slot. ServUO `WeaponAbility.SetAbility`.
      // Layout (post-header): u32 abilityId. We stamp onto the mobile
      // so onHitProcs / weapon-abilities.js can fire it on next swing.
      const abilityId = r.readU32() >>> 0;
      const mob = state.mobile;
      if (!mob) break;
      // ServUO convention: even ids are primary, odd are secondary. We
      // keep both slots so a player can prime two abilities at once.
      if (abilityId === 0) {
        mob._primaryAbility = null;
        mob._secondaryAbility = null;
      } else if ((abilityId & 1) === 0) {
        mob._primaryAbility = abilityId;
      } else {
        mob._secondaryAbility = abilityId;
      }
      break;
    }
    case 0x28: {
      // GuildGumpRequest — client opens the guild roster. We resolve
      // the player's guild via the registry and let the guild gump
      // system render. Fallback: short system message when the player
      // isn't in a guild.
      const gReg = state.ctx?.guildRegistry;
      const myGuild = gReg?.guildOf?.(state.mobile?.serial);
      if (!myGuild) {
        state.sendSystemMessage?.('You are not in a guild.');
        break;
      }
      // Optional: a guild-gump renderer (server-side) — wire when one
      // exists. For now surface the basic roster as a system message
      // so the player has something concrete to act on.
      const roster = Array.from(myGuild.members ?? []).slice(0, 12);
      state.sendSystemMessage?.(
        `[${myGuild.abbreviation ?? 'GLD'}] ${myGuild.name ?? 'Guild'} — ${roster.length} member(s)`,
      );
      break;
    }
    case 0x32: {
      // QuestGumpRequest — client opens the quest log. Delegate to the
      // ML quest registry; fallback to a system-message summary so the
      // player at least knows which quests they hold.
      const ml = state.ctx?.mlQuests ?? state.ctx?.systems?.mlQuests;
      const active = ml?.listActive?.(state.mobile) ?? [];
      if (!active.length) {
        state.sendSystemMessage?.('You have no active quests.');
        break;
      }
      state.sendSystemMessage?.(`Active quests (${active.length}):`);
      for (const q of active.slice(0, 6)) {
        state.sendSystemMessage?.(`  • ${q.title ?? q.id}`);
      }
      break;
    }
    default:
      console.log(`[net#${state.id}] 0xD7 unknown subop 0x${sub.toString(16)}`);
  }
}

/**
 * Krrios party-position broadcast — reply with the current location of
 * every party member (and any guild member if guild-broadcast is on).
 * Format mirrors what `worldmap-entity-manager.js` parses on the
 * client side.
 */
export function handleKrriosRequest(state) {
  const me = state.mobile;
  if (!me) return;
  const partyReg = state.ctx.partyRegistry;
  const party = partyReg?.partyOf?.(me.serial);
  // Audit #37 P2 #6 — ServUO `Misc/ProtocolExtensions.cs:102` subop
  // byte is `0x01` for party-locations (was `0xF0` — wrong). CUO's
  // worldmap-entity-manager refused our reply silently. Also drop
  // self + in-range members; ServUO only sends out-of-range members
  // because in-range ones are already visible via 0x77/0x78.
  const UPDATE_RANGE = 18;
  const members = [];
  if (party) {
    for (const serial of party.members ?? new Set()) {
      const m = state.ctx.world.mobiles.get(serial);
      if (!m || m === me) continue;
      // Skip in-range — client already has them via 0x77/0x78.
      if (m.map === me.map
          && Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)) <= UPDATE_RANGE) continue;
      members.push(m);
    }
  }
  // Build reply.
  const PER_ENTRY = 4 + 2 + 2 + 1;
  const total = 1 + 2 + 1 + 4 + members.length * PER_ENTRY + 4;
  const buf = new Uint8Array(total);
  let o = 0;
  buf[o++] = 0xF0;
  buf[o++] = (total >>> 8) & 0xff; buf[o++] = total & 0xff;
  buf[o++] = 0x01;                                  // canonical subop
  const leader = (party?.leader ?? me.serial) >>> 0;
  buf[o++] = (leader >>> 24) & 0xff; buf[o++] = (leader >>> 16) & 0xff;
  buf[o++] = (leader >>> 8)  & 0xff; buf[o++] = leader & 0xff;
  for (const m of members) {
    const s = m.serial >>> 0;
    buf[o++] = (s >>> 24) & 0xff; buf[o++] = (s >>> 16) & 0xff;
    buf[o++] = (s >>> 8)  & 0xff; buf[o++] = s & 0xff;
    buf[o++] = ((m.x | 0) >>> 8) & 0xff; buf[o++] = (m.x | 0) & 0xff;
    buf[o++] = ((m.y | 0) >>> 8) & 0xff; buf[o++] = (m.y | 0) & 0xff;
    buf[o++] = (m.map | 0) & 0xff;
  }
  // Terminator (4-byte zero serial).
  buf[o++] = 0; buf[o++] = 0; buf[o++] = 0; buf[o++] = 0;
  try { state.send(buf); }
  catch { /* socket transient */ }
}
