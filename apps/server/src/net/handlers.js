// Opcode handlers. Each handler takes (netState, rawPacket) and consumes it.
//
// Handlers registered here implement the login flow and bring a player
// into the world; gameplay opcodes (movement, speech, etc.) are registered
// alongside and gated by NetState.stage.

import {
  PacketReader,
  serverList,
  playServerAck,
  characterList,
  loginConfirm,
  supportedFeatures,
  loginComplete,
  characterLocale,
  extMapChange,
  extMapPatches,
  extExtendedStats,
  seasonChange,
  overallLightLevel,
  personalLightLevel,
  weather,
  mobileUpdate,
  mobileIncoming,
  mobileMoving,
  movementAck,
  movementRej,
  unicodeMessage,
  loginReject,
  LoginRejectReason,
  clientVersionRequest,
  playSound,
} from '@uo/protocol';
import { Stage } from './net-state.js';
import { SKILL_TO_COMMAND } from './skill-actions.js';
import { trace } from '../trace.js';
import { verifyPassword } from './accounts.js';
import { displayGumpPacked, PACKED_GUMP_THRESHOLD } from './gump-packed.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeUrl from 'node:url';
import { nearbyClients, nearbyMobiles, nearbyItems } from '../world/visibility.js';
import { castSpell as castSpellDispatch, getSpell, disturbCast } from '../systems/spells/index.js';
import { has as hasEffect } from '../status-effects.js';
import { stamp as stampAggression } from '../aggression.js';
import { lineOfSight } from '../world/los.js';
import {
  containerChildren, createItem, findMergeableStack, mergeStacks, splitStack,
  totalWeight, wornWeight,
} from '../world/items.js';
import { useItem as useTemplateItem, spawn as spawnTemplate, getTemplate } from '../world/templates.js';
import * as itemsMod from '../world/items.js';
import { markAttrDirty } from '../world/attributes.js';
// Direct ref to setItemParent — used by all drag/drop/trade reparent
// paths so the reverse `_childrenByParent` index follows the move.
// Without this, drag chains leave stale entries in the per-parent Set
// (audit #2 A5). Returns the item for chaining.
const setItemParent = itemsMod.setItemParent;
import { resolveStep, resolveStandingZ } from '../world/movement.js';
import { assignRace } from '../systems/race.js';
import { dispatchItemEvent, dispatchTileWalkEvents } from '../world/item-scripts.js';
import {
  hitChance, rollDamage, swingDelayMs, damageRiders, onHitProcs,
  effectiveSkill, effectiveWeaponSkill,
  applyConfidenceParryStamina,
  WEAPON_SKILLS, SKILL_TACTICS, SKILL_ANATOMY, SKILL_PARRYING,
} from '../combat-formulas.js';
import { tryGain } from '../skill-gain.js';
import { canDamage as canDamageYoung } from '../systems/young-player.js';
import { recordDamage } from '../world/damage-tracking.js';
import { flagCriminal } from '../notoriety.js';
import { canArenaAttack } from '../systems/pvp/pvp-arena.js';
import { handleBulletinPacket } from '../systems/bulletin-board.js';
import { dispatch as dispatchXmlAttachment } from '../systems/world/xml-attachments.js';
import {
  worldItemSA, removeEntity, dropAck, bounce,
  displayContainer, containerContents, containerContentUpdate,
  mobileStatus, healthUpdate, manaUpdate, staminaUpdate,
  openPaperdoll, sendSkills, readTargetResponse, targetRequest,
  displayGump, readGumpResponse,
  equipUpdate, readWearItem,
  displayContextMenu,
  openBuyWindow, vendorSellList, readBuyRequest, readSellReply,
  openBookNew, bookPages, readBookPages, readBookHeader,
  extNewSpellbookContent,
  warmode, readWarmode, playerAnimation, damagePacket,
  unicodePrompt, readUnicodePromptReply,
  readPartyCommand, readTradeCommand, readHelpRequest, readGuildMessage,
  tradeOpen, tradeClose, tradeCheck,
  graphicalEffect, huedEffect, EffectKind,
  oplInfo, objectProperties, readOPLRequest, computeOPLHash,
  questArrow,
  readProfileRequest, profileResponse,
} from '@uo/protocol';
import { attackLimiter } from './attack-limiter.js';
import * as helpQueue from '../help-queue.js';
import * as chatChannels from '../chat-channels.js';

/** @typedef {(state: import('./net-state.js').NetState, pkt: Uint8Array) => void} Handler */
/** @typedef {Record<number, Handler>} HandlerTable */

/**
 * @returns {HandlerTable}
 */
export function buildHandlers() {
  return {
    0xEF: handleLoginSeed,
    0x80: handleAccountLogin,
    0xA0: handlePlayServer,
    0x91: handleGameLogin,
    0xA4: handleSystemInfo,
    0x73: handlePing,
    0xBD: handleClientVersion,
    0xE1: handleClientType,
    0xBE: handleAssistVersion,
    0xF8: handleCreateCharacter70160,
    0x00: handleCreateCharacter,
    0x5D: handlePlayCharacter,
    0xB8: handleProfileReq,
    0xBF: handleExtendedCommand,
    0x02: handleMovementReq,
    0xAD: handleUnicodeSpeech,
    0x06: handleUseReq,
    0x05: handleAttackReq,
    0x22: handleResynchronize,
    0xD1: handleLogoutReq,
    // 0xF0 Krrios assist API — emit reply with current party member
    // positions so the client's worldmap-entity-manager can show
    // out-of-range pins on the world map. Layout we reply with:
    //   u8 0xF0, u16 len, u8 0xF0 (sub), u32 leaderSerial,
    //   for each member: u32 serial + u16 x + u16 y + u8 mapId
    //   trailing u32 0 terminator.
    0xF0: handleKrriosRequest,
    0x07: handlePickUp,
    0x08: handleDrop,
    0x34: handleStatusReq,
    0x6C: handleTargetResponse,
    0xB1: handleGumpResponse,
    0x13: handleWearItem,
    0x3B: handleBuyRequest,
    0x9F: handleSellReply,
    0x66: handleBookPagesInbound,
    0xD4: handleBookHeaderInbound,
    0x72: handleWarmodeReq,
    0xC2: handlePromptReply,
    0x6F: handleTradeCommand,
    0x71: handleBulletinBoardReq,
    0x9B: handleHelpRequest,
    0xD6: handleOPLRequest,
    0xD7: handleHouseCustomization,
    0x09: handleLookReq,
    0x12: handleTextCommand,
    0x75: handleRenameReq,
    0x83: handleDeleteCharacter,
    0x01: handleDisconnectNotify,
    0x3A: handleSkillLockChange,
    0x95: handleHuePickerResponse,
    0x98: handleMobileNameRequest,
    0x9A: handleAsciiPromptResponse,
    0x9D: handleGMSingle,
    0xB6: handleObjectHelpRequest,
    0xC8: handleClientViewRange,
    0xEC: handleEquipMacro,
    0xED: handleUnequipMacro,
    // Audit 2026-05-15 — protocol gaps closed.
    // P1 real handlers — log/enqueue with side-effects.
    0xF4: handleCrashReport,        // crash telemetry → server log
    0x8D: handleECCreateCharacter,  // Enhanced Client create char
    0xBB: handleAccountIDPacket,    // alt login flow (some launchers)
    // Silent stubs (legacy / Razor / debug) — accept + drop so the
    // socket reader doesn't desync. Each one is a no-op in modern flow.
    0x03: handleLegacyAsciiSpeech,
    0x04: handleNoOp,               // GodModeRequest
    0x0A: handleNoOp,               // Edit (god-client terrain edit)
    0x14: handleNoOp,               // ChangeZ (god-client)
    0x2C: handleDeathStatusResponse,// DeathStatusResponse — ghost-ack
    0x47: handleNoOp,               // NewTerrain
    0x48: handleNoOp,               // NewAnimData (god)
    0x58: handleNoOp,               // NewRegion (god)
    0x61: handleNoOp,               // DeleteStatic
    0x79: handleNoOp,               // ResourceQuery
    0x7D: handleNoOp,               // MenuResponse
    0x7E: handleNoOp,               // GodviewQuery
    0x96: handleNoOp,               // GameCentralMonitor
    0xA7: handleNoOp,               // RequestScrollWindow
    0xC9: handleNoOp,               // TripTime (Razor)
    0xCA: handleNoOp,               // UTripTime (Razor)
    0xCF: handleNoOp,               // AccountLogin alt
    0xD0: handleNoOp,               // ConfigurationFile upload
    0xFA: handleNoOp,               // legacy UltimaStore
    0xFB: handleNoOp,               // PublicHouseContent
  };
}

// ---- Legacy / Razor / debug opcodes ------------------------------------
//
// These are accepted-and-ignored to keep the socket in sync. The modern
// CUO and CUO-fork clients never send most of these; legacy clients
// (Razor, EC, UltraThin, pre-AOS edits) may.
function handleNoOp(_state, _pkt) { /* intentional */ }

/**
 * 0x2C DeathStatusResponse — 2 bytes (u8 opcode + u8 mode).
 * ServUO `PacketHandlers.OnDeathStatusResponse`: client answers
 * "manifest as ghost" (0x02) / "resurrected" (0x01) prompts. Server
 * uses the ack only as a visual liveness signal so we just clear any
 * pending death-prompt flag on the netstate.
 */
function handleDeathStatusResponse(state, _pkt) {
  state._pendingDeathPrompt = false;
}

/** 0x03 AsciiSpeech (pre-Unicode). Modern path is 0xAD UnicodeSpeech. */
function handleLegacyAsciiSpeech(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  // Layout: u8 0x03, u16 len, u8 type, u16 hue, u16 font, ASCII text (null-term).
  if (pkt.length < 9) return;
  const type = pkt[3] | 0;
  const hue = ((pkt[4] << 8) | pkt[5]) & 0xffff;
  const font = ((pkt[6] << 8) | pkt[7]) & 0xffff;
  let text = '';
  for (let i = 8; i < pkt.length; i++) {
    const c = pkt[i];
    if (!c) break;
    text += String.fromCharCode(c);
    if (text.length > 256) break;
  }
  if (!text.trim()) return;
  processPlayerSpeech(state, { type, hue, font, lang: 'ENU', text });
}

/** 0xF4 CrashReport — client crash telemetry. ServUO logs to file;
 *  we log to console + optional shard-events for ops visibility. */
function handleCrashReport(state, pkt) {
  // Layout: u8 0xF4, u16 len, raw text (UTF-8). Cap at 4 KiB.
  if (pkt.length < 4) return;
  const body = Buffer.from(pkt.subarray(3, Math.min(pkt.length, 4096)))
    .toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
  const acctId = state.account?.id ?? 'anon';
  console.warn(`[client-crash] account=${acctId}: ${body}`);
  try {
    state.ctx?.systems?.shardEvents?.emit?.('client-crash', body, {
      account: acctId,
    });
  } catch { /* shard-events optional */ }
}

/** 0x8D ECCreateCharacter — Enhanced Client.
 *  Layout (per ServUO Network/PacketHandlers.cs `CreateCharacterEnhanced`):
 *    u8 0x8D, u16 len, u32 charSlot, char name[30], char unk[30],
 *    u8 profession, u8 unk, u32 clientFlag, u32 unk, u32 loginCount,
 *    u8 sex(race-merged), u8 str, u8 dex, u8 int, u16 hue,
 *    u16 hairId, u16 hairHue, u16 facialId, u16 facialHue, u16 shirtHue,
 *    u16 pantsHue, u16 startCity, u32 slot,
 *    u8 skill1, u8 val1, u8 skill2, u8 val2, u8 skill3, u8 val3, u8 skill4, u8 val4.
 *  We extract the same fields the classic 0xF8 path needs and call
 *  bringIntoWorld with the unified spec. */
function handleECCreateCharacter(state, pkt) {
  if (state.stage !== Stage.CharList) {
    // Some clients send 0x8D before stage flips — accept anyway, the
    // sub-paths will gate on account context.
  }
  if (pkt.length < 80) {
    console.warn('[net] 0x8D EC create-char too short:', pkt.length);
    return;
  }
  try {
    const r = new PacketReader(pkt);
    r.readU8();                    // opcode
    r.readU16();                   // len (variable for 0x8D)
    r.readU32();                   // pattern
    let name = '';
    for (let i = 0; i < 30; i++) {
      const c = r.readU8();
      if (c) name += String.fromCharCode(c);
    }
    name = name.trim();
    r.skip(30);                    // unknown 30-byte block
    const profession = r.readU8();
    r.readU8();                    // unk
    r.readU32();                   // clientFlag
    r.readU32();                   // unk
    r.readU32();                   // loginCount
    const sex = r.readU8();
    const str = r.readU8();
    const dex = r.readU8();
    const intel = r.readU8();
    const skinHue = r.readU16();
    const hairId = r.readU16();
    const hairHue = r.readU16();
    const facialId = r.readU16();
    const facialHue = r.readU16();
    const shirtHue = r.readU16();
    const pantsHue = r.readU16();
    const cityIndex = r.readU16();
    r.readU32();                   // slot
    const skills = {};
    for (let i = 0; i < 4; i++) {
      if (r.remaining < 2) break;
      const sid = r.readU8(), sval = r.readU8();
      if (sid >= 0 && sid <= 57 && sval > 0) skills[sid + 1] = sval;
    }
    const { race, female } = decodeClassicCreateGenderRace(sex, sex >= 4);
    bringIntoWorld(state, {
      name, sex: female ? 1 : 0, race, profession,
      str: str | 0, dex: dex | 0, int: intel | 0,
      skills, skinHue,
      hair: hairId ? { itemId: hairId, hue: hairHue } : null,
      beard: facialId ? { itemId: facialId, hue: facialHue } : null,
      shirtHue, pantsHue, cityIndex,
    });
  } catch (e) {
    console.warn('[net] 0x8D EC create-char parse failed:', e.message);
    // Fallback to classic parser.
    try { handleCreateCharacter70160(state, pkt); }
    catch { /* nothing more */ }
  }
}

/** 0xBB AccountID — some launchers send a "verify account" probe before
 *  0x80 AccountLogin. Layout is account-name(30) + password(30). We
 *  accept and let the regular 0x80 flow do the actual auth. */
function handleAccountIDPacket(state, pkt) {
  if (pkt.length < 61) return;
  // Just stash the name on state so 0x80 path can prefer it.
  let name = '';
  for (let i = 1; i < 31; i++) {
    const c = pkt[i];
    if (!c) break;
    name += String.fromCharCode(c);
  }
  if (name && !state.account?.id) state._pendingAccountName = name;
}

// ---- 0x09 LookReq -------------------------------------------------------
//
// Client single-clicks a mobile/item. ServUO responds with either an OPL
// header (modern clients) or a speech packet showing the target's name.
// We send a 0x1C ASCII speech ("System" label) with the name — it's the
// simplest path that works on every client version.
function handleLookReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.ctx?.world) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const world = state.ctx.world;
  const target = world.mobiles?.get(serial) ?? world.items?.get(serial);
  if (!target) return;
  // Resolve display name. Priority: explicit `name` > cliloc lookup
  // for `labelNumber` (signs ship labelNumber=cliloc id like 1016093
  // = "Court of Truth"; without the lookup the click reported
  // "item #2998" — a useless static-art id) > fallback placeholder.
  let name = target.name;
  if (!name && target.labelNumber) {
    name = clilocText(target.labelNumber);
  }
  if (!name) name = target.tileId ? `item #${target.tileId}` : `mobile #${serial.toString(16)}`;
  // FAZA DB: paragon mobs render their single-click name in the same
  // gold hue ServUO uses for `paragon` PropertyList headers (0x0035).
  // Visual cue so a paragon's bright orange body isn't the only tell.
  const hue = target.paragon ? 0x0035 : 0x03B2;
  // FAZA DL: append karma title for player mobiles. ServUO ranks
  // karma in 6 brackets; the heroic + dread brackets (≥10000 / ≤-10000)
  // earn "the Glorious Lord" / "the Dread Lord" suffixes that ride on
  // PropertyList headers. We splice them into the single-click line so
  // the title is visible without OPL.
  if (target.client && typeof target.karma === 'number') {
    const karmaTitle = karmaTitleFor(target);
    if (karmaTitle) name = `${name}, ${karmaTitle}`;
  }
  // FAZA GG: AFK marker in single-click. Pure UX — no gameplay effect.
  if (target.client && target.afk) name = `${name} (AFK)`;
  state.send(unicodeMessage({
    serial: serial >>> 0,
    graphic: 0xFFFF,
    type: 0, // regular
    hue,
    font: 3,
    name: 'You see',
    text: String(name),
  }));
}

// Lazy-loaded cliloc table. The client ships the same JSON at
// `apps/client/public/assets/cliloc.json` (~123k entries from
// extracted UO `Cliloc.enu`). We resolve once on first use so signs,
// place markers, and any other item that ships `labelNumber` instead
// of an explicit `name` get a human-readable single-click label.
/** @type {Record<string,string> | null} */
let _clilocTable = null;
let _clilocChecked = false;
function clilocText(num) {
  if (!_clilocChecked) {
    _clilocChecked = true;
    try {
      const here = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
      const candidates = [
        nodePath.resolve(here, '..', '..', '..', 'client', 'public', 'assets', 'cliloc.json'),
        nodePath.resolve(here, '..', '..', '..', '..', 'apps', 'client', 'public', 'assets', 'cliloc.json'),
      ];
      for (const p of candidates) {
        if (nodeFs.existsSync(p)) {
          const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'));
          _clilocTable = j?.entries ?? j ?? null;
          break;
        }
      }
    } catch (e) {
      console.warn('[cliloc] load failed:', e.message);
    }
  }
  if (!_clilocTable) return null;
  return _clilocTable[String(num | 0)] ?? null;
}

// FAZA DL: karma → suffix. Mirrors ServUO `Notoriety` / `Titles` brackets.
function karmaTitleFor(mob) {
  const k = mob.karma | 0;
  if (k >=  10000) return 'the Glorious Lord';
  if (k >=   5000) return 'the Honorable';
  if (k >=   1250) return 'the Trustworthy';
  if (k <= -10000) return 'the Dread Lord';
  if (k <=  -5000) return 'the Wicked';
  if (k <=  -1250) return 'the Disgraced';
  return null;
}

// ---- 0x12 TextCommand ---------------------------------------------------
//
// Variable-length packet: op(1) len(2) type(1) command(ascii\0). Used for
// skill invocation, /emote, /bow, etc. Type 0x24 = skill-use-by-number;
// command body is the skill id as an ASCII decimal string. ServUO:
// PacketHandlers.TextCommand. We only wire the skill-use path for now.
/**
 * Run the cast pipeline for a spell triggered by a UI macro / hotkey.
 * Shared by 0x12 type 0x56 (legacy text-command cast) and 0xBF 0x1C
 * (modern action-bar cast). Implements the cast-then-target flow:
 *   1. play casting animation + sound at the caster
 *   2. wait def.delayMs (the cast bar)
 *   3. solicit the target cursor (for spells with `requiresTarget`)
 *   4. invoke `castSpell({...})` with the proper context object
 *
 * Centralised so the dispatch path can't drift between the two callers
 * — the previous 0x1C handler had bit-rotted into a no-op call with
 * positional args, which silently failed AND left the client's cast
 * lock armed (every subsequent cast looked ignored).
 */
function dispatchCastFromMacro(state, spellId) {
  const def = getSpell(spellId);
  if (!def) {
    state.sendSystemMessage?.(`Unknown spell (${spellId}).`);
    return;
  }
  const world = state.ctx?.world;
  // ServUO FCR cap — reject re-cast attempts during the post-cast
  // recovery window. The stamp is set further down after the spell
  // fires; a non-staff caster can't cast again until `_castReadyAt`.
  const isStaffCast = state.account?.accessLevel === 'GM'
                   || state.account?.accessLevel === 'Admin';
  if (!isStaffCast && (state.mobile?._castReadyAt ?? 0) > Date.now()) {
    state.sendSystemMessage?.('You must wait a moment before casting again.');
    return;
  }
  const deps = {
    damage: (w, v, n, opts) => {
      if (!state.ctx?.handlers) return;
      const attacker = (opts && typeof opts === 'object' && opts.attacker) || state.mobile;
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
        combat?.damage?.(w, v, n, { ...opts, attacker });
      } else {
        combat?.damage?.(w, v, n, attacker, opts);
      }
    },
    statusEffects: state.ctx?.statusEffects,
    animate: (w, m, action, opts) => combat.animate(w, m, action, opts),
    playSoundNear: (w, m, sound) => combat.playSoundNear(w, m, sound),
    broadcastSpellWords: (w, caster, words) => {
      if (!words) return;
      const pkt = unicodeMessage({
        serial: caster.serial >>> 0,
        graphic: caster.body & 0xFFFF,
        type: 10, hue: 0x0035,
        font: 3, language: 'ENU',
        name: caster.name ?? '', text: words,
      });
      if (caster.client) caster.client.send(pkt);
      for (const m of w.mobiles.values()) {
        if (!m.client || m === caster) continue;
        if (m.map !== caster.map) continue;
        if (Math.abs(m.x - caster.x) > 18 || Math.abs(m.y - caster.y) > 18) continue;
        m.client.send(pkt);
      }
    },
  };
  // FC (FasterCasting) scales the cast-time delay: each point cuts
  // 250 ms off `def.delayMs`. Audit #30 P1 #1 — per-school cap matches
  // ServUO `Spell.cs::GetCastDelay`:
  //   Magery / Necromancy / Mysticism: cap 2 (always)
  //   Chivalry / Bushido / Ninjitsu:   cap 4, drops to 2 when Magery ≥ 70
  //   (Protection spell active subtracts 2 from the effective cap)
  // The old `recentlyPvP ? 2 : 4` was a uniform-school heuristic that let
  // mages stack FC4 in PvE, halving cast times beyond intent.
  const attrs = state.ctx?.attributes ?? null;
  let fcRaw = attrs?.effective?.(state.mobile)?.fasterCasting | 0;
  // Essence of Wind subtracts FC for `_essenceWindFCMalus` points
  // (typically focusLevel + 1). Acts as a soft cast-time slow.
  if ((state.mobile?._essenceWindUntil ?? 0) > Date.now()) {
    fcRaw -= (state.mobile._essenceWindFCMalus | 0);
  }
  let fcCap;
  switch (def.school) {
    case 'magery': case 'necromancy': case 'mysticism':
      fcCap = 2; break;
    case 'chivalry': case 'bushido': case 'ninjitsu':
      // Skill id 26 = Magery (from `apps/scripts/src/data/config/skills.json`).
      fcCap = effectiveSkill(state.mobile, 26) >= 70 ? 2 : 4; break;
    default: fcCap = 2; break;        // spellweaving / unknown
  }
  // Protection narrows the cap by 2 (and floors at 0). Same penalty
  // ServUO `Spell.GetCastDelay` applies before clamping.
  if (state.mobile && hasEffect(state.mobile, 'protection')) fcCap = Math.max(0, fcCap - 2);
  const fc = Math.max(0, Math.min(fcCap, fcRaw));
  const fcrRaw = attrs?.effective?.(state.mobile)?.fasterCastRecovery | 0;
  const fcr = Math.max(0, Math.min(6, fcrRaw));
  const scaledDelay = Math.max(0, (def.delayMs | 0) - fc * 250);
  // 1 s base recovery, reduced 150 ms per FCR point (min 250 ms). Stamp
  // BEFORE setTimeout so a fast click while the cursor is up still hits
  // the FCR gate at the top of this function.
  const recoveryMs = Math.max(250, 1000 - fcr * 150);
  if (state.mobile) state.mobile._castReadyAt = Date.now() + scaledDelay + recoveryMs;

  if (def.requiresTarget) {
    try { combat.animate(world, state.mobile,
      def.areaCast ? 0x11 : 0x10, { frameCount: 7, repeatCount: 1 }); }
    catch { /* non-fatal */ }
    if (def.soundId) {
      try { combat.playSoundNear(world, state.mobile, def.soundId); }
      catch { /* non-fatal */ }
    }
    const fireTarget = () => {
      const cursorKind = def.targetKind === 'location' ? 1 : 0;
      targeting.request(state, (picked) => {
        if (!picked) {
          state.sendSystemMessage?.('Targeting cancelled.');
          return;
        }
        let target = null;
        if (picked.serial) {
          target = world?.mobiles?.get?.(picked.serial >>> 0) ?? null;
        }
        if (!target && (picked.x | picked.y)) {
          target = {
            x: picked.x | 0, y: picked.y | 0, z: picked.z | 0,
            map: state.mobile.map ?? 1,
            graphic: picked.graphic | 0,
          };
        }
        const tDeps = { ...deps, animate: undefined, playSoundNear: undefined };
        const r = castSpellDispatch({
          caster: state.mobile, target, world, spellId, deps: tDeps,
          accessLevel: state.account?.accessLevel,
        });
        if (!r.ok && r.reason && state.sendSystemMessage) {
          state.sendSystemMessage(`Cast failed: ${r.reason}.`);
        }
      }, { kind: cursorKind });
    };
    if (scaledDelay > 0) setTimeout(fireTarget, scaledDelay);
    else fireTarget();
    return;
  }
  const r = castSpellDispatch({
    caster: state.mobile, target: null, world, spellId, deps,
    accessLevel: state.account?.accessLevel,
  });
  if (!r.ok && r.reason && state.sendSystemMessage) {
    state.sendSystemMessage(`Cast failed: ${r.reason}.`);
  }
}

function handleTextCommand(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();   // op + len
  const type = r.readU8();
  const body = pkt.subarray(4);
  // Read remaining ASCII null-terminated. Cap at 256 chars to be safe.
  let cmd = '';
  while (r.remaining > 0) {
    const c = r.readU8();
    if (!c) break;
    cmd += String.fromCharCode(c);
    if (cmd.length > 256) break;
  }
  switch (type) {
    case 0x24: {
      // BUGFIX #9 (FAZA AS): "Skill use by numeric id" — when the player
      // drags a skill icon to their CUO action bar and double-clicks it,
      // the client sends 0x12 type 0x24 with the skill id as ASCII
      // text. The previous code printed a TODO stub, so action bars
      // couldn't invoke ANY skill — a user-visible regression every
      // time someone tried to use Hiding/Stealth/Meditation from the
      // bar. Now we route the skill id to the matching `[command` if
      // one exists. Skills with no built-in command (Tactics, Anatomy
      // etc. — passive use during combat) just emit a hint message.
      const skillId = parseInt(cmd, 10);
      // Skill id (canon 1-indexed) → command line. `dispatch` re-parses
      // the line and surfaces argv via `ctx.args`, so we can route a
      // skill straight to its craft-menu variant. Crafting skills all
      // funnel through `[craft gump <skillname>` which emits the
      // `@@OPEN_CRAFT_GUMP@@…` marker the client picks up to open the
      // CUO-style craft browser. Previously 1/8/9/12/35 (Alchemy /
      // Blacksmithy / Bowcraft / Carpentry / Tailoring) had no entry
      // and the player saw "Skill N is passive" instead of a craft
      // menu when invoking the diamond — user report 2026-05-17.
      const cmdName = SKILL_TO_COMMAND[skillId];
      if (cmdName) {
        const handled = state.ctx.commands.dispatch(cmdName, {
          sender: state.mobile, state, world: state.ctx.world,
        });
        if (!handled) {
          state.sendSystemMessage?.(`Skill ${skillId} — handler missing.`);
        }
      } else if (Number.isFinite(skillId)) {
        state.sendSystemMessage?.(
          `Skill ${skillId} is passive — it trains during combat or use.`,
        );
      } else if (cmd.startsWith('racialAbility ')) {
        // Audit rev.9 P2 #2 — RacialAbilitiesBookGump sends `0x24
        // racialAbility <id>` for any passive that the gump exposes.
        // For passive flags we just stamp a marker on the mob (the
        // various consumers — combat-formulas, regen, crafting — check
        // for `mob.racialAbility.has(id)`). Active abilities like
        // Berserk arm a 30 s window. Flying has its own 0xBF 0x32 path
        // and never reaches this branch.
        const id = cmd.slice('racialAbility '.length).trim();
        const mob = state.mobile;
        if (mob && id) {
          if (!mob.racialAbility) mob.racialAbility = new Set();
          if (id === 'berserk') {
            mob._berserkUntil = Date.now() + 30_000;
            state.sendSystemMessage?.('Your gargish fury rises — +damage at low HP for 30s.');
          } else if (id === 'master-artisan' || id === 'workhorse' ||
                     id === 'strong-back' || id === 'tough' ||
                     id === 'jack-of-all-trades' || id === 'mystic-insight' ||
                     id === 'deadly-aim' || id === 'night-sight' ||
                     id === 'infused-wisdom' || id === 'difficult-track' ||
                     id === 'wisdom-elves' || id === 'knowledge-nature') {
            mob.racialAbility.add(id);
            state.sendSystemMessage?.(`Racial trait '${id}' is now passively active.`);
          } else {
            state.sendSystemMessage?.(`Unknown racial ability: ${id}.`);
          }
        }
      }
      break;
    }
    case 0x43:
      // OpenSpellBook — CUO sends 0x12 subtype 0x43 plus one raw byte:
      // SpellBookType (Magery=0, Necro=1, Chiv=2, Bushido=3, ...).
      // Route to the same 0xBF 0x1B content push as double-clicking the
      // physical spellbook item.
      openOwnedSpellbookByType(state, body[0] ?? 0);
      break;
    case 0x58: // Open door
      // Doors aren't implemented as interactive statics yet.
      break;
    case 0x56: {
      // Cast spell (legacy): type 0x56 + absolute spell id in the command
      // string. Modern clients use 0xBF 0x1C instead, but we support both.
      const spellId = parseInt(cmd, 10);
      if (!Number.isFinite(spellId)) break;
      dispatchCastFromMacro(state, spellId);
      break;
    }
    default:
      // Unknown — log and ignore.
      break;
  }
}

// ---- 0x75 RenameRequest -------------------------------------------------
//
// Rename a pet / owned mobile. Packet: op(1) serial(4) newName(30 ASCII).
// ServUO validates ownership + name policy (no profanity, length). We do
// a minimal ownership check (target must be state.mobile or a followed
// pet) and update the name in place.
function handleRenameReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  let newName = r.readAsciiFixed(30).replace(/\0+$/, '').trim();
  if (!newName) return;
  // Server parity #12 #4 — sanitize: ASCII-printable only, length 1..30.
  newName = newName.replace(/[^\x20-\x7E]/g, '').slice(0, 30);
  if (!newName) return;
  const target = state.ctx?.world?.mobiles?.get(serial);
  if (!target) return;
  // Allow the player themselves OR the master of a tamed pet. Was
  // self-only — players couldn't rename their own pets.
  const isSelf = target === state.mobile;
  const isMyPet = target.controlMaster === state.mobile.serial;
  if (!isSelf && !isMyPet) return;
  target.name = newName;
  if (state.sendSystemMessage) state.sendSystemMessage(`Renamed to ${newName}.`);
}

// ---- 0x83 DeleteCharacter -----------------------------------------------
//
// Character-list screen → delete slot. Packet: op(1) pass(30) slot(4 LE).
// ServUO validates password, then removes the character from the account.
// We log and acknowledge; persistent character deletion is a persistence-
// layer concern that hasn't been wired up in our account storage yet.
function handleDeleteCharacter(state, pkt) {
  if (state.stage !== Stage.CharacterList && state.stage !== Stage.AccountLogin) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const pass = r.readAsciiFixed(30).replace(/\0+$/, '');
  const slot = r.readU32();
  // Bug-hunt #8 #9: was ignoring the password AND not bounds-checking the
  // slot — any authenticated session could wipe arbitrary character
  // entries on the same account (incl. integer slots above the array
  // length, bloating sparse storage). Validate the password against the
  // session's account hash before mutating anything.
  const acc = state.account;
  if (!acc) return;
  if (pass && acc.hash && !verifyPassword(pass, acc.hash)) {
    state.sendSystemMessage?.('Incorrect password — character not deleted.');
    return;
  }
  if (!Array.isArray(acc.characters)) return;
  if (slot < 0 || slot >= acc.characters.length) {
    state.sendSystemMessage?.('Invalid character slot.');
    return;
  }
  acc.characters[slot] = null;
  // Send 0x86 CharacterListUpdate next if we track that packet; for now
  // rely on the client to re-request the list.
}

// ---- 0x01 Disconnect Notify ----------------------------------------------
//
// Classic client sends this before closing the socket. No response needed;
// the connection will be torn down by the transport layer. Handler exists
// so the packet dispatcher doesn't treat it as unknown/error.
function handleDisconnectNotify(state /*, pkt */) {
  // Intentional no-op — net-state.js onClose() will run the cleanup.
  void state;
}

function handleLoginSeed(state, pkt) {
  if (state.stage !== Stage.LoginSeed) return;
  const r = new PacketReader(pkt);
  r.readU8(); // opcode
  state.seed = r.readU32();
  // Remaining bytes are clientMajor/Minor/Revision/Prototype (u32 × 4).
  state.stage = Stage.AccountLogin;
}

function handleAccountLogin(state, pkt) {
  if (state.stage !== Stage.AccountLogin && state.stage !== Stage.LoginSeed) {
    return;
  }
  const r = new PacketReader(pkt);
  r.readU8();
  const user = r.readAsciiFixed(30);
  const password = r.readAsciiFixed(30);
  r.readU8(); // next-login flags

  if (!user) {
    state.send(loginReject(LoginRejectReason.Invalid));
    state.close();
    return;
  }

  // Rate-limit per-account login attempts (port of ServUO
  // AccountAttackLimiter.cs). After FREE_ATTEMPTS failures within a
  // sliding 60s window, each additional attempt waits N×1s before the
  // reject is sent — defeats credential-stuffing without locking the
  // account permanently. Composite key (account + remote address) so a
  // single shared NAT'd box doesn't lock everyone out.
  const limiterKey = `${user.toLowerCase()}|${state.remoteAddress ?? '?'}`;
  const throttle = attackLimiter.shouldThrottle(limiterKey);
  if (throttle) {
    setTimeout(() => {
      try {
        state.send(loginReject(LoginRejectReason.Invalid));
        state.close();
      } catch { /* socket already gone */ }
    }, throttle.delayMs);
    return;
  }

  // Authenticate against AccountDB. devAutoAccept toggles auto-creation of
  // unknown accounts (handy during local development).
  const accounts = state.ctx.accounts;
  if (accounts) {
    const res = accounts.authenticate(user, password, { autoCreate: state.ctx.config.devAutoAccept });
    if (!res.ok) {
      attackLimiter.recordFailure(limiterKey);
      const reason = res.reason === 'bad password' ? LoginRejectReason.BadPassword
        : res.reason === 'banned' ? LoginRejectReason.Blocked
        : LoginRejectReason.Invalid;
      state.send(loginReject(reason));
      state.close();
      return;
    }
    state.account = res.account;
  }
  attackLimiter.recordSuccess(limiterKey);
  state.accountName = user;

  // Send server list (single-shard: this one).
  state.send(serverList([
    {
      name: state.ctx.config.shardName,
      fullPercent: 0,
      timeZone: 0,
      address: state.ctx.config.advertisedAddress,
    },
  ]));
  state.stage = Stage.AwaitServerPick;
}

function handlePlayServer(state, _pkt) {
  if (state.stage !== Stage.AwaitServerPick) return;
  // We only advertise one server, so the client's choice is ignored.
  const authKey = state.ctx.authKeys.issue(state.accountName);
  state.send(playServerAck(
    state.ctx.config.advertisedAddress,
    state.ctx.config.port,
    authKey,
  ));
  // The classic client closes and reconnects. Our WS client keeps the same
  // socket and immediately sends 0x91 — both paths are valid.
  state.stage = Stage.GameLogin;
}

function handleGameLogin(state, pkt) {
  // 0x91 is also how a *fresh* connection identifies itself after the relay,
  // so we accept it in either LoginSeed (reconnect) or GameLogin (same-socket) stage.
  if (state.stage !== Stage.GameLogin && state.stage !== Stage.LoginSeed) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const authKey = r.readU32();
  const user = r.readAsciiFixed(30);
  r.readAsciiFixed(30); // password

  const resolved = state.ctx.authKeys.consume(authKey);
  // Bug-hunt #9 #10 (security P1): devAutoAccept fallthrough used to
  // accept ANY username when `resolved == null` (bad/expired auth key)
  // — a reconnecting attacker could impersonate any account by name in
  // a deploy where the dev flag was accidentally left on. Hard-fail if
  // we're in production OR if the account name doesn't match.
  const inProd = process.env.NODE_ENV === 'production';
  const devOk = !!state.ctx.config.devAutoAccept && !inProd;
  if (!resolved || (state.accountName && resolved !== state.accountName)) {
    if (!devOk) {
      state.send(loginReject(LoginRejectReason.BadCommunication));
      state.close();
      return;
    }
    // In dev-accept, only let the original 0x80 binding through — never
    // a free-form claim of someone else's account name.
    if (state.accountName && resolved && resolved !== state.accountName) {
      state.send(loginReject(LoginRejectReason.BadCommunication));
      state.close();
      return;
    }
  }
  state.accountName = resolved ?? user;
  // On a fresh-socket reconnect we never saw 0x80, so `state.account` is still
  // null — rebind it from the account DB so downstream code (access-level
  // checks on commands, persistence bindings) can see it.
  if (!state.account && state.ctx.accounts) {
    const acc = state.ctx.accounts.accounts.get(state.accountName.toLowerCase());
    if (acc) state.account = acc;
  }

  // CRITICAL: flip the stage to CharList BEFORE the two sends below.
  // The Huffman gate in `net-state.send` keys off `state.stage` — login
  // phase (LoginSeed / AccountLogin / AwaitServerPick / GameLogin) goes
  // out RAW, post-GameLogin (CharList / InWorld) goes out COMPRESSED.
  // ClassicUO desktop expects the 0xB9 features + 0xA9 char-list to be
  // Huffman-compressed (canonical post-relay behaviour); without this
  // ordering they shipped raw, CUO tried to Huffman-decode them, got
  // garbage and hung on "Logging into Shard…" (Marcin's symptom).
  state.stage = Stage.CharList;
  state.send(supportedFeatures());
  // Existing dev world: no persistent chars, just offer starting locations and
  // an empty character list. The client can create a character with 0xF8.
  state.send(characterList(
    [{ name: state.accountName }], // one pre-named slot for convenience
    [
      { city: 'Trinsic',     area: 'City Gate',           x: 1825, y: 2728, z: 0 },
      { city: 'Moonglow',    area: 'Town Square',         x: 4459, y: 1086, z: 0 },
      { city: 'Britain',     area: 'Mage Shop',           x: 1500, y: 1598, z: 0 },
    ],
  ));
}

function handleSystemInfo() { /* no-op */ }
function handlePing(state, pkt) {
  // 0x73 ping is echoed back with the canonical 2-byte form. Bug-hunt
  // #8 #8: was echoing the FULL incoming buffer, so a malicious client
  // could amplify by sending fat ping frames. Plus a soft rate limit
  // (≤8 pings/s) so the echo path can't be used as a CPU lever either.
  const now = Date.now();
  if ((state._pingCount | 0) >= 8 && (now - (state._pingWindowStart | 0)) < 1000) {
    return;     // silently drop excess pings
  }
  if (now - (state._pingWindowStart | 0) >= 1000) {
    state._pingWindowStart = now;
    state._pingCount = 0;
  }
  state._pingCount = (state._pingCount | 0) + 1;
  // Canonical 2-byte response: opcode (0x73) + seq byte from pkt[1].
  const seq = pkt && pkt.length > 1 ? pkt[1] : 0;
  state.send(Buffer.from([0x73, seq]));
}
function handleClientVersion(state, pkt) {
  const r = new PacketReader(pkt);
  r.readU8();
  const len = r.readU16();
  const versionString = r.readAsciiNull(Math.max(0, len - 3)).trim();
  if (!versionString) return;

  const version = parseClientVersion(versionString);
  state.clientVersionString = versionString;
  state.clientVersion = version;
  if (version) {
    state.dropReqSize = clientVersionAtLeast(version, 6, 0, 1, 7) ? 15 : 14;
  }
}

function parseClientVersion(versionString) {
  const parts = String(versionString).match(/\d+/g)?.map((n) => Number(n)) ?? [];
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return {
    major: parts[0] | 0,
    minor: parts[1] | 0,
    revision: parts[2] | 0,
    patch: parts[3] | 0,
  };
}

function clientVersionAtLeast(version, major, minor, revision, patch) {
  const got = [version.major, version.minor, version.revision, version.patch];
  const want = [major, minor, revision, patch];
  for (let i = 0; i < want.length; i++) {
    if (got[i] > want[i]) return true;
    if (got[i] < want[i]) return false;
  }
  return true;
}

function handleClientType() { /* no-op */ }
function handleAssistVersion() { /* no-op */ }
// 0xB8 — character profile read or write. ServUO `Mobile.OnProfileRequest`.
// Profiles persist on `mob.profileBody` (a unicode string). Reading a
// stranger's profile returns whatever they typed; writing is only allowed
// for your own character. Length is capped at 1024 chars to dodge spam.

const SKILL_LOCK_FROM_WIRE = ['up', 'down', 'locked'];
const SKILL_LOCK_TO_WIRE = Object.freeze({ up: 0, down: 1, locked: 2 });

function skillValueRaw(mob, skillId) {
  return effectiveSkill(mob, skillId);
}

function skillCapRaw(mob, skillId) {
  const v = mob?.skillCaps?.[skillId] ?? mob?.skillCaps?.[String(skillId)] ?? 100;
  return Number.isFinite(Number(v)) ? Number(v) : 100;
}

function skillLockToWire(lock) {
  if (typeof lock === 'number' && lock >= 0 && lock <= 2) return lock | 0;
  return SKILL_LOCK_TO_WIRE[lock] ?? 0;
}

function skillLockFor(mob, skillId) {
  const locks = mob?.skillLocks;
  if (!locks) return 0;
  return skillLockToWire(
    locks[skillId] ?? locks[String(skillId)] ??
    locks[skillId - 1] ?? locks[String(skillId - 1)],
  );
}

// 0x3A — skill lock change. ServUO `Mobile.OnSkillLock`. The client
// sends this when the player clicks the up/down/lock arrow on the
// skills gump. Layout: u8 op, u16 len(=6), u16 skillId, u8 newLock.
//
// BUGFIX #13 (FAZA AW): without this handler the lock click hit the
// server's "no handler for 0x3A" log and the gump's optimistic update
// stuck only client-side. After a relog the lock state revealed it
// was never persisted. Now we update `mob.skillLocks[id]` server-side
// and echo back a single-skill 0x3A so the client confirms.
function handleSkillLockChange(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile || pkt.length < 6) return;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  /* const len = */ dv.getUint16(1);
  const clientSkillId = dv.getUint16(3);
  const newLock = dv.getUint8(5) & 0xff;
  if (newLock > 2) return;
  const mob = state.mobile;
  const skillId = clientSkillId + 1;
  mob.skillLocks ??= {};
  mob.skillLocks[skillId] = SKILL_LOCK_FROM_WIRE[newLock] ?? 'up';
  // Echo back a 0x3A "single skill update" (type 0xDF, with cap) so the client
  // resyncs from authoritative state — same wire format as the bulk
  // skills reply. Client sends a zero-based id; server storage and
  // protocol builders use canonical one-based ids.
  const value = skillValueRaw(mob, skillId);
  state.send(sendSkills({
    type: 0xDF,
    skills: [{
      id: skillId,
      value,
      base: value,
      lock: newLock,
      cap: skillCapRaw(mob, skillId),
    }],
  }));
}

function handleProfileReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  let req;
  try {
    req = readProfileRequest(pkt);
  } catch (e) {
    console.warn(`[net#${state.id}] bad 0xB8: ${e.message}`);
    return;
  }
  const world = state.ctx?.world;
  const target = world?.mobiles?.get?.(req.target >>> 0);
  if (!target) return;
  if (req.kind === 'update' && (req.target >>> 0) === (state.mobile.serial >>> 0)) {
    target.profileBody = String(req.body ?? '').slice(0, 1024);
  }
  state.send(profileResponse({
    serial: target.serial,
    header: `Profile of ${target.name ?? 'a stranger'}`,
    title: '',
    body: target.profileBody ?? '',
  }));
}
function handleResynchronize(state) {
  // Bug-hunt #10 #4 — 0x22 spam amplifies into MB/s of nearby-mobile
  // egress + heavy server CPU (buildEquipByOwner + streaming). Cap at
  // 1/sec per client to prevent line-rate abuse.
  const now = Date.now();
  if (now - (state._lastResyncAt ?? 0) < 1000) return;
  state._lastResyncAt = now;
  // Client 0x22 ClientResyncRequest. Fired by ClassicUO after a long stall
  // (e.g. alt-tab back, network hiccup) to say "my world state may be
  // stale, please push everything around me again". We re-stream the same
  // data the initial join did — self mobileUpdate + surroundings — minus
  // the one-time login packets (feature flags, map change, login-complete).
  refreshSurroundings(state);
}

/**
 * Re-push the player's own snap + every in-range mob/item back to their
 * client. Used by 0x22 ClientResyncRequest AND by server-initiated
 * teleports (admin panel `/api/me/teleport`, `[go`, ...) so the player
 * actually sees the new area instead of an empty viewport until the next
 * movement packet trickles in.
 */
export function refreshSurroundings(state) {
  if (state?.stage !== Stage.InWorld) return;
  const mob = state.mobile;
  if (!mob) return;

  state.send(mobileUpdate({
    serial: mob.serial,
    body: mob.body, hue: mob.hue, flags: mob.flags,
    x: mob.x, y: mob.y, z: mob.z, direction: mob.direction,
  }));
  // ONE walk over world.items to bucket equipment by owner — shared
  // across self + every nearbyMobiles iteration. Without this, each
  // mob's equipmentFor() did its own full O(items) walk and a refresh
  // around 50 mobs × 110k items spent ~5.5M iterations on equipment
  // lookups alone.
  const equipByOwner = buildEquipByOwner(state.ctx.world);

  state.send(mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue, flags: mob.flags, notoriety: mob.notoriety,
    equipment: equipmentFor(state.ctx.world, mob, equipByOwner),
  }));
  state.send(healthUpdate({ serial: mob.serial, current: mob.hp ?? 50, max: mob.hpMax ?? 50 }));
  // Same mana+stam priming as the initial-login path — without these,
  // a `[resync` (or facet swap that re-runs this branch) leaves the
  // HealthBar / StatusGump M and S wells empty until the user clicks
  // the title to fire a manual status request.
  state.send(manaUpdate({ serial: mob.serial, current: mob.mana ?? 50, max: mob.manaMax ?? 50 }));
  state.send(staminaUpdate({ serial: mob.serial, current: mob.stam ?? 50, max: mob.stamMax ?? 50 }));

  // Reset the visibility cache — refreshSurroundings is the "I've sent
  // you everything in range right now" baseline that `streamVisibilityDelta`
  // diffs against on each subsequent step.
  state._visibleItems  = new Set();
  state._visibleMobiles = new Set();
  // Unlike initial login (which only streams other players), resync also
  // needs NPCs — the client may have discarded a skeleton's sprite while
  // stalled and there's no movement packet to re-seed it. `nearbyMobiles`
  // yields every in-range mobile regardless of whether it has a client.
  for (const other of nearbyMobiles(state.ctx.world, mob, mob)) {
    state.send(mobileIncoming({
      serial: other.serial, body: other.body, x: other.x, y: other.y, z: other.z,
      direction: other.direction, hue: other.hue, flags: other.flags, notoriety: other.notoriety,
      equipment: equipmentFor(state.ctx.world, other, equipByOwner),
    }));
    state.send(healthUpdate({ serial: other.serial, current: other.hp ?? 50, max: other.hpMax ?? 50 }));
    state._visibleMobiles.add(other.serial >>> 0);
  }
  // Item streaming — BATCHED via setImmediate to prevent the client
  // from freezing on a TP into a busy area. Britain Bank has 200+
  // grounded items + statics; blasting all 200 in one synchronous
  // tick floods the WS frame, the client's net handler runs each
  // 0xF3 sync (decode + emit + ensureItem) and queues an async
  // _mountItem chain per packet. Result: ~1000+ microtasks queued
  // in one go → animation frames starve → "po teleportacji blokuje
  // cala gre". Yielding every BATCH_SIZE items via setImmediate lets
  // the WS write drain, the libuv loop service other I/O, and on
  // the client side gives the renderer's RAF a chance to fire
  // between bursts. 30 was picked empirically — well under one
  // typical WS frame, two-digit ms of CPU each.
  const items = [];
  for (const item of nearbyItems(state.ctx.world, mob)) items.push(item);
  if (items.length === 0) return;
  const BATCH_SIZE = 30;
  let cursor = 0;
  const flushBatch = () => {
    // The state may have closed (logout, disconnect) between batches.
    if (state._closed || state.stage !== Stage.InWorld) return;
    const end = Math.min(cursor + BATCH_SIZE, items.length);
    for (; cursor < end; cursor++) {
      try {
        state.sendItem(items[cursor]);
        state._visibleItems?.add(items[cursor].serial >>> 0);
      }
      catch { /* per-item failure shouldn't kill the batch */ }
    }
    if (cursor < items.length) setImmediate(flushBatch);
  };
  flushBatch();
}
function handleLogoutReq(state) { state.close('logout'); }

/**
 * Per-step visibility delta — ServUO-style "sector subscription". As the
 * player walks across the world, items + mobs that newly come within
 * `UPDATE_RANGE` get streamed (worldItemSA / mobileIncoming) and those
 * leaving range get a `0x1D removeEntity` so the client can free them.
 *
 * Implementation: maintain a Set<serial> on the NetState of items the
 * client currently has loaded. On each move, compute the in-range
 * snapshot and diff against the set: anything new → send + add; anything
 * gone → remove + delete.
 *
 * Cheap: bounded by ~80 items × 1 per direction step. Skipped entirely
 * when the move stays inside the SAME 8×8 sector (no new tiles enter
 * the visibility window).
 */
function streamVisibilityDelta(state, mob, prevX, prevY) {
  const world = state.ctx?.world;
  if (!world) return;
  // Run on every accepted step (not only sector crossing). With large
  // streamed worlds this prevents the "walk a few tiles and see empty
  // horizon until next sector edge" effect after teleports/resync.
  trace('vis', `net#${state.id} step from=(${prevX},${prevY}) to=(${mob.x},${mob.y}); ` +
    `prevSize items=${state._visibleItems?.size ?? 0} mobs=${state._visibleMobiles?.size ?? 0}`);
  // Lazy-init the per-client visibility cache.
  state._visibleItems  ||= new Set();
  state._visibleMobiles ||= new Set();
  const seenI = state._visibleItems;
  const seenM = state._visibleMobiles;
  const nextI = new Set();
  const nextM = new Set();
  let itemStreamErrors = 0;
  try {
    for (const item of nearbyItems(world, mob)) {
      const s = item.serial >>> 0;
      nextI.add(s);
      if (!seenI.has(s)) {
        try { state.sendItem(item); }
        catch {
          itemStreamErrors++;
          if (itemStreamErrors <= 3) {
            console.warn(`[visibility] sendItem failed serial=0x${(item.serial >>> 0).toString(16)}`);
          }
        }
      }
    }
  } catch (e) { console.warn('[visibility] item stream threw:', e?.message); }
  try {
    for (const other of nearbyMobiles(world, mob, mob)) {
      const s = other.serial >>> 0;
      nextM.add(s);
      if (!seenM.has(s)) {
        state.send(mobileIncoming({
          serial: other.serial, body: other.body,
          x: other.x, y: other.y, z: other.z,
          direction: other.direction, hue: other.hue,
          flags: other.flags, notoriety: other.notoriety,
          equipment: equipmentFor(world, other),
        }));
        state.send(healthUpdate({
          serial: other.serial, current: other.hp ?? 50, max: other.hpMax ?? 50,
        }));
      }
    }
  } catch (e) { console.warn('[visibility] mob stream threw:', e?.message); }
  // Drop entries that left the window.
  let dropI = 0, dropM = 0;
  for (const s of seenI) {
    if (!nextI.has(s)) { state.send(removeEntity(s)); dropI++; }
  }
  for (const s of seenM) {
    if (!nextM.has(s)) { state.send(removeEntity(s)); dropM++; }
  }
  const newI = nextI.size - (seenI.size - dropI);
  const newM = nextM.size - (seenM.size - dropM);
  // Safety net: if we previously had a healthy item window and it suddenly
  // collapsed to zero, trigger a one-shot surroundings refresh. This covers
  // index drift / transient stream faults without forcing the player to relog.
  if (nextI.size === 0 && seenI.size >= 16 && (world.items?.size ?? 0) > 0) {
    const now = Date.now();
    if (now - (state._lastVisibilityRecoveryAt ?? 0) > 1500) {
      state._lastVisibilityRecoveryAt = now;
      console.warn(`[visibility] net#${state.id} empty-item window after movement (seen=${seenI.size}) -> refreshSurroundings`);
      refreshSurroundings(state);
      return;
    }
  }
  trace('vis', `net#${state.id} delta: items +${newI} -${dropI} (now ${nextI.size}); ` +
    `mobs +${newM} -${dropM} (now ${nextM.size})`);
  state._visibleItems  = nextI;
  state._visibleMobiles = nextM;
}

function handlePlayCharacter(state, pkt) {
  if (state.stage !== Stage.CharList) return;
  const r = new PacketReader(pkt);
  r.readU8();
  r.skip(4); // pattern1
  const name = r.readAsciiFixed(30);
  bringIntoWorld(state, name);
}

function handleCreateCharacter(state, pkt) {
  if (state.stage !== Stage.CharList) return;
  bringIntoWorld(state, parseCreateCharacter(pkt, /* extended */ false));
}

function handleCreateCharacter70160(state, pkt) {
  if (state.stage !== Stage.CharList) return;
  bringIntoWorld(state, parseCreateCharacter(pkt, /* extended */ true));
}

/**
 * FAZA BR — parse the 0x00 / 0xF8 CreateCharacter packet beyond the bare
 * name. We extract the user's selections (sex, skin hue, hair + facial hair
 * art ids and hues, profession, four skills) so the character actually
 * reflects what was chosen on the creator screen instead of always being
 * a fixed male newbie. The two opcodes share the same body shape; 0xF8
 * just adds a couple of trailing u16s we ignore here.
 *
 * @param {Uint8Array} pkt
 * @param {boolean} extended  true for 0xF8 (post-7.0.16.0)
 * @returns {{
 *   name:string, sex:0|1, race:number, profession:number,
 *   str:number, dex:number, int:number,
 *   skills: Record<number, number>,
 *   skinHue:number,
 *   hair:{ itemId:number, hue:number } | null,
 *   beard:{ itemId:number, hue:number } | null,
 *   shirtHue:number, pantsHue:number,
 * }}
 */
export function _parseCreateCharacterForTest(pkt, extended) {
  return parseCreateCharacter(pkt, extended);
}
function parseCreateCharacter(pkt, extended) {
  const r = new PacketReader(pkt);
  r.readU8();         // opcode
  r.readU32();        // patternRevision (or 0xEDEDEDED)
  r.readU32();        // clientFlag
  r.readU8();         // unk
  const name = r.readAsciiFixed(30).replace(/\0+$/, '').trim();
  r.skip(2);          // unk
  r.readU32();        // featureFlags
  r.readU32();        // unk
  r.readU32();        // loginCount
  const profession = r.readU8();
  r.skip(15);         // padding
  const genderRace = r.readU8();    // 0xF8: 2/3 human, 4/5 elf, 6/7 gargoyle; odd values are female.
  const str = r.readU8();
  const dex = r.readU8();
  const intel = r.readU8();
  const skill1 = r.readU8(), val1 = r.readU8();
  const skill2 = r.readU8(), val2 = r.readU8();
  const skill3 = r.readU8(), val3 = r.readU8();
  let skill4 = -1, val4 = 0;
  if (extended) { skill4 = r.readU8(); val4 = r.readU8(); }
  const skinHue = r.readU16();
  const hairId  = r.readU16();
  const hairHue = r.readU16();
  const facialHairId  = r.readU16();
  const facialHairHue = r.readU16();
  // Trailing fields per modern 0xF8: locationId(u16), zero(u16),
  // charSlot(u16), clientIp(u32), shirtHue(u16), pantsHue(u16). The
  // older 0x00 path is short-compatible here. We honour locationId so
  // the client's city pick actually controls where the avatar spawns.
  let cityIndex = 0;
  let shirtHue = 0, pantsHue = 0;
  try { cityIndex = r.readU16(); } catch { /* short-form may end here */ }
  try { r.readU32(); } catch { /* slot — ignored */ }
  try { r.readU32(); } catch { /* clientIP — ignored */ }
  try { shirtHue = r.readU16(); } catch { /* pre-AOS skips this */ }
  try { pantsHue = r.readU16(); } catch { /* pre-AOS skips this */ }
  /** @type {Record<number, number>} */
  const skills = {};
  for (const [skillId, value] of [[skill1, val1], [skill2, val2], [skill3, val3], [skill4, val4]]) {
    // ClassicUO sends zero-based SkillName enum indexes; the runtime
    // stores canonical skill ids as 1..58 everywhere else.
    if (skillId >= 0 && skillId <= 57 && value > 0) skills[skillId + 1] = value;
  }
  const { race, female } = decodeClassicCreateGenderRace(genderRace, extended);
  return {
    name,
    sex: /** @type {0|1} */ (female ? 1 : 0),
    race,
    profession,
    str: str | 0, dex: dex | 0, int: intel | 0,
    skills,
    skinHue: skinHue | 0,
    hair: hairId ? { itemId: hairId, hue: hairHue } : null,
    beard: facialHairId ? { itemId: facialHairId, hue: facialHairHue } : null,
    shirtHue, pantsHue,
    cityIndex,
  };
}

// ---------------------------------------------------------------------------
// Character-creation validation + lookup tables
// ---------------------------------------------------------------------------

/** Reserved name fragments — case-insensitive substring match. Mirrors
 *  ServUO `NameVerification.cs` denylist (slimmed). */
const RESERVED_NAME_FRAGMENTS = [
  'gm', 'admin', 'staff', 'lord british', 'blackthorn',
  'jaana', 'mariah', 'shamino', 'iolo', 'dupre', 'geoffrey',
  'system', 'server', 'console', 'fuck', 'shit', 'cunt', 'nigger',
];
/** Allowed name pattern: letters, spaces, apostrophes, hyphens. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z' -]{1,29}$/;

/** Returns `null` when `name` is acceptable, otherwise a short reason
 *  string suitable for an error message back to the client. */
function validateCharacterName(name) {
  const trimmed = (name ?? '').trim();
  if (trimmed.length < 2)  return 'name too short';
  if (trimmed.length > 30) return 'name too long';
  if (!NAME_PATTERN.test(trimmed)) return 'illegal characters in name';
  const lower = trimmed.toLowerCase();
  for (const frag of RESERVED_NAME_FRAGMENTS) {
    if (lower.includes(frag)) return `name contains reserved fragment "${frag}"`;
  }
  return null;
}

/** Starter-city table — index matches the ClassicUO city pick gump
 *  (0..8). Coords are the canonical OSI start spawns; map=1 (Trammel)
 *  for new players. Mirrors ServUO `CharacterCreation.cs` city block. */
const STARTER_CITIES = [
  { name: 'New Haven', x: 3667, y: 2625, z: 0,   map: 1 },   // 0 default
  { name: 'Britain',   x: 1496, y: 1624, z: 10,  map: 1 },
  { name: 'Trinsic',   x: 1825, y: 2728, z: 0,   map: 1 },
  { name: 'Moonglow',  x: 4459, y: 1086, z: 0,   map: 1 },
  { name: 'Yew',       x:  548, y:  979, z: 0,   map: 1 },
  { name: 'Magincia',  x: 3777, y: 2225, z: 19,  map: 1 },
  { name: 'Skara Brae',x:  643, y: 2067, z: 5,   map: 1 },
  { name: 'Vesper',    x: 2876, y:  676, z: 0,   map: 1 },
  { name: 'Minoc',     x: 2477, y:  411, z: 15,  map: 1 },
];

/** Body id per (race, sex). 0=human, 1=elf, 2=gargoyle. Falls back to
 *  human when an unknown race id arrives. */
function bodyForRace(race, female) {
  switch (race | 0) {
    case 1: return female ? 0x025E : 0x025D;   // elf
    case 2: return female ? 0x029B : 0x029A;   // gargoyle
    default: return female ? 0x0191 : 0x0190;  // human
  }
}

const CREATOR_RACE_NAMES = ['human', 'elf', 'gargoyle'];

function raceNameFromCreatorIndex(race) {
  return CREATOR_RACE_NAMES[Math.max(0, Math.min(2, race | 0))] ?? 'human';
}

function racePacketId(race, body = 0) {
  if (body === 0x0190 || body === 0x0191) return 1;
  if (body === 0x025D || body === 0x025E) return 2;
  if (body === 0x029A || body === 0x029B || body === 0x0666 || body === 0x0667) return 3;
  if (race === 1 || race === 'human') return 1;
  if (race === 2 || race === 'elf') return 2;
  if (race === 3 || race === 'gargoyle') return 3;
  return 1;
}

const ELF_SKIN_HUES = new Set([
  0x4DE, 0x76C, 0x835, 0x430, 0x24D, 0x24E, 0x24F, 0x0BF,
  0x4A7, 0x361, 0x375, 0x367, 0x3E8, 0x3DE, 0x353, 0x903,
  0x76D, 0x384, 0x579, 0x3E9, 0x374, 0x389, 0x385, 0x376,
  0x53F, 0x381, 0x382, 0x383, 0x76B, 0x3E5, 0x51D, 0x3E6,
]);

function normalizeCreatorSkinHue(race, hue) {
  const raw = hue | 0;
  const value = raw & 0x3fff;
  switch (race | 0) {
    case 1:
      return (ELF_SKIN_HUES.has(value) ? value : 0x4DE) | 0x8000;
    case 2:
      return Math.max(1755, Math.min(1779, value || 1755)) | 0x8000;
    default:
      return Math.max(1002, Math.min(1058, value || 1002)) | 0x8000;
  }
}

function isValidCreatorHair(race, female, itemId) {
  const id = itemId | 0;
  if (id === 0) return false;
  switch (race | 0) {
    case 1:
      if ((female && (id === 0x2FCD || id === 0x2FBF)) || (!female && (id === 0x2FCC || id === 0x2FD0))) return false;
      return (id >= 0x2FBF && id <= 0x2FC2) || (id >= 0x2FCC && id <= 0x2FD1);
    case 2:
      if (!female) return id >= 0x4258 && id <= 0x425F;
      return id === 0x4261 || id === 0x4262
        || (id >= 0x4273 && id <= 0x4275)
        || id === 0x42B0 || id === 0x42B1
        || id === 0x42AA || id === 0x42AB;
    default:
      if ((female && id === 0x2048) || (!female && id === 0x2046)) return false;
      return (id >= 0x203B && id <= 0x203D) || (id >= 0x2044 && id <= 0x204A);
  }
}

function isValidCreatorBeard(race, female, itemId) {
  const id = itemId | 0;
  if (id === 0 || female) return false;
  switch (race | 0) {
    case 1:
      return false;
    case 2:
      return id >= 0x42AD && id <= 0x42B0;
    default:
      return (id >= 0x203E && id <= 0x2041) || (id >= 0x204B && id <= 0x204D);
  }
}

/**
 * Pick a clothing preset name from the CreateCharacter `profession` byte.
 * Profession ids come from ClassicUO's `professions` array (0 = Advanced
 * custom, 1 = Warrior, 2 = Mage, ...). Anything outside the table falls
 * back to peasant.
 */
function presetFromProfession(profession) {
  switch (profession | 0) {
    case 1: return 'warrior';
    case 2: return 'mage';
    case 3: return 'blacksmith';
    case 4: return 'necromancer';
    case 5: return 'paladin';
    case 6: return 'samurai';
    case 7: return 'ninja';
    default: return 'peasant';
  }
}

/**
 * FAZA BR character-creator presets. Each preset names item.json template
 * keys + the paperdoll layer the piece equips on. Mirrors the table in
 * apps/scripts/src/items/clothing-presets.js but lives server-side so
 * `bringIntoWorld()` can dress the player BEFORE script command dispatch
 * is even reachable. Layers come from the canonical UO Layer enum.
 */
const CREATOR_PRESETS = {
  peasant: [
    { template: 'shirt',      layer:  5, hue: 904 },
    { template: 'long-pants', layer:  4, hue: 954 },
    { template: 'sandals',    layer:  3, hue: 1107 },
  ],
  warrior: [
    { template: 'leather-tunic',    layer: 13 },
    { template: 'leather-leggings', layer: 24 },
    { template: 'leather-cap',      layer:  6 },
    { template: 'boots',            layer:  3 },
  ],
  mage: [
    { template: 'fancy-shirt', layer:  5, hue: 1109 },
    { template: 'long-pants',  layer:  4, hue:   38 },
    { template: 'robe',        layer: 22, hue:   38 },
    { template: 'wizard-hat',  layer:  6, hue:   38 },
    { template: 'shoes',       layer:  3, hue:   68 },
  ],
  blacksmith: [
    { template: 'shirt',       layer:  5, hue: 1107 },
    { template: 'long-pants',  layer:  4, hue: 1109 },
    { template: 'full-apron',  layer: 22, hue:   68 },
    { template: 'boots',       layer:  3 },
  ],
  necromancer: [
    { template: 'robe',        layer: 22, hue:   38 },
    { template: 'skullcap',    layer:  6, hue:   38 },
    { template: 'sandals',     layer:  3, hue: 1107 },
  ],
  paladin: [
    { template: 'leather-tunic',    layer: 13, hue: 0x03B2 },
    { template: 'leather-leggings', layer: 24, hue: 0x03B2 },
    { template: 'boots',            layer:  3 },
    { template: 'body-sash',        layer: 12, hue: 0x00CF },
  ],
  samurai: [
    { template: 'shirt',       layer:  5, hue: 0x02C3 },
    { template: 'long-pants',  layer:  4, hue: 0x02C3 },
    { template: 'wide-brim-hat', layer: 6, hue: 0x02C3 },
    { template: 'boots',       layer:  3 },
    { template: 'bokuto',      layer:  1 },
  ],
  ninja: [
    { template: 'shirt',       layer:  5, hue: 0x0090 },
    { template: 'short-pants', layer:  4, hue: 0x0090 },
    { template: 'bandana',     layer:  6, hue: 0x0090 },
    { template: 'body-sash',   layer: 12, hue: 0x0090 },
    { template: 'boots',       layer:  3 },
    { template: 'bokuto',      layer:  1 },
  ],
  bandit: [
    { template: 'shirt',       layer:  5, hue: 37 },
    { template: 'short-pants', layer:  4, hue: 38 },
    { template: 'bandana',     layer:  6, hue: 37 },
    { template: 'boots',       layer:  3 },
    { template: 'body-sash',   layer: 12, hue: 37 },
  ],
};

/**
 * Equip a creator preset onto a freshly-built mobile. Falls back to the
 * legacy hard-coded outfit when the requested preset (or any of its
 * templates) isn't registered yet — this happens during cold boot if the
 * scripts directory hasn't loaded items.json before someone logs in.
 *
 * @param {*} world
 * @param {*} mob
 * @param {string} presetName
 */
function applyOutfitForCreator(world, mob, presetName) {
  const preset = CREATOR_PRESETS[presetName] ?? CREATOR_PRESETS.peasant;
  let any = false;
  for (const piece of preset) {
    if (!getTemplate(piece.template)) continue;
    try {
      spawnTemplate(world, piece.template, {
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        parent: mob.serial,
        layer: piece.layer,
        ...(piece.hue != null ? { hue: piece.hue } : {}),
      });
      any = true;
    } catch { /* template missing — fall through */ }
  }
  if (!any) {
    // Cold-boot safety net: scripts haven't registered yet, drop the
    // hard-coded newbie outfit so the new character isn't naked.
    outfitFreshMobile(world, mob);
  }
}

/**
 * Find the player-character mobile that this account owns.
 *
 * Mobiles created via the CreateCharacter path are stamped with
 * `isPlayer = true` and `accountName = state.accountName` so we can
 * unambiguously distinguish a player avatar from any of the hundreds
 * of NPCs / spawned monsters that share the same monotonic serial
 * counter (`SerialAllocator.allocMobile`).
 *
 * Without this validation, `account.mobileSerial` was just an integer
 * pointing into `world.mobiles` — and if a spawn had ever overwritten
 * the slot (which used to happen when the new char serial collided with
 * a freshly-allocated NPC after a save round-trip) the player would
 * `0x5D` log in and be bound to the wrong mobile. The classic symptom
 * was an admin reconnecting and seeing themselves as "a mature pixie"
 * with body 0x80 — the slot WAS theirs, but now it was an NPC.
 *
 * Resolution order:
 *   1. `account.mobileSerial` AND mob has `isPlayer === true` AND its
 *      `accountName` matches → use it.
 *   2. Walk all mobiles, find any with `isPlayer===true` and matching
 *      `accountName` → use the first (rebinds account.mobileSerial).
 *   3. Legacy save (no isPlayer flag): find a humanoid (body 0x190 / 0x191)
 *      whose `name` matches the account name → adopt it as the player
 *      mob and stamp the new fields on it. This auto-heals saves from
 *      before the marker existed.
 *   4. Nothing matched → return null (caller falls into create-char path).
 */
function resolvePlayerMobile(world, state) {
  const accountName = state.accountName ?? state.account?.username;
  const boundSerial = state.account?.mobileSerial;
  // 1) Validate the explicit binding.
  if (boundSerial != null) {
    const existing = world.mobiles.get(boundSerial >>> 0);
    if (existing
        && existing.isPlayer
        && (!accountName || existing.accountName === accountName)) {
      return existing;
    }
  }
  if (!accountName) return null;
  // 2) Search by accountName for a properly-marked player mobile.
  for (const m of world.mobiles.values()) {
    if (m.isPlayer && m.accountName === accountName) {
      _rebindAccount(state, m);
      return m;
    }
  }
  // 3) Legacy heuristic — name match on a humanoid body. Adopt + stamp.
  const wantedName = accountName.toLowerCase();
  for (const m of world.mobiles.values()) {
    const isHumanoid = m.body === 0x0190 || m.body === 0x0191
                    || m.body === 0x000C || m.body === 0x000D;
    if (!isHumanoid) continue;
    if ((m.name ?? '').toLowerCase() !== wantedName) continue;
    m.isPlayer = true;
    m.accountName = accountName;
    _rebindAccount(state, m);
    console.log(`[net] adopted legacy player mob 0x${m.serial.toString(16)} (${m.name}) for account ${accountName}`);
    return m;
  }
  return null;
}

function _rebindAccount(state, mob) {
  if (!state.account) return;
  if (state.account.mobileSerial === (mob.serial >>> 0)) return;
  state.account.mobileSerial = mob.serial >>> 0;
  try { state.ctx.accounts?.saveSync(); } catch { /* ignore */ }
}

/**
 * Push the shard's command catalogue (`0xBF` subop `0xA0`) to a single
 * state. Filtered by the player's accessLevel. Called at LoginComplete
 * and again after every script hot-reload so the right-edge command
 * panel never falls out of sync.
 *
 * @param {*} state
 */
export function pushCommandCatalogue(state) {
  // No stage gate: at LoginComplete the catalogue is pushed BEFORE
  // `state.stage = Stage.InWorld` (set after the surround stream).
  if (!state?.send) {
    console.warn('[cmd-catalog] refused: state.send missing');
    return;
  }
  try {
    const reg = state.ctx?.commands ?? state.ctx?.commandRegistry;
    if (!reg?.commands) {
      console.warn('[cmd-catalog] refused: ctx.commands missing on state');
      return;
    }
    // Defensive re-promote — recheck UO_ADMINS env every push so an
    // accidental in-session demotion (or a fresh account-DB load that
    // reset the cached object) gets corrected before we filter commands.
    // User report 2026-05-18: "po raz kolejny moje konto jest traktowane
    // jako player" after `[createworld`.
    try {
      const refreshed = state.ctx?.accounts?.recheckPromotion?.(state.accountName);
      if (refreshed) state.account = refreshed;
    } catch { /* advisory — fall through to whatever state.account has */ }
    const acc = state.account?.accessLevel ?? 'Player';
    const ACCESS_ORDER = {
      Player: 0, Counselor: 1, Counsellor: 1, Seer: 2,
      GM: 3, GameMaster: 3, Admin: 4, Administrator: 4,
    };
    const myLevel = ACCESS_ORDER[acc] ?? 0;
    const list = [];
    let skipped = 0;
    for (const c of reg.commands.values()) {
      if (!c || typeof c.name !== 'string' || c.name === '') { skipped++; continue; }
      const reqd = ACCESS_ORDER[c.access ?? 'Admin'] ?? 4;
      if (reqd > myLevel) { skipped++; continue; }
      list.push({ name: c.name, help: c.help ?? '', access: c.access ?? 'Admin' });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`[cmd-catalog] push to ${state.account?.username ?? '?'} (${acc}): ${list.length} commands (registry total: ${reg.commands.size}, skipped: ${skipped})`);
    // Surface the count to the player so they can immediately tell
    // whether the push went through (no need to inspect server logs).
    try {
      state.sendSystemMessage?.(`Commands available: ${list.length} (access: ${acc}).`);
    } catch { /* sendSystemMessage optional */ }
    const json = JSON.stringify({ accessLevel: acc, commands: list });
    const bytes = Buffer.from(json, 'utf8');
    const pkt = Buffer.alloc(5 + 2 + bytes.length);
    pkt[0] = 0xBF;
    pkt.writeUInt16BE(5 + 2 + bytes.length, 1);   // total len
    pkt.writeUInt16BE(0x00A0, 3);                  // subop
    pkt.writeUInt16BE(bytes.length, 5);            // payload len
    bytes.copy(pkt, 7);
    state.send(pkt);
  } catch (e) { console.warn('[cmd-catalog] push failed:', e?.message, e?.stack); }
}

/** Broadcast the command catalogue to every in-world connected state.
 *  Called after script hot-reload so newly-registered (or unregistered)
 *  commands surface in the player's panel without requiring a relog. */
export function pushCommandCatalogueToAll(world) {
  if (!world?.mobiles) return;
  for (const mob of world.mobiles.values()) {
    if (mob.client) pushCommandCatalogue(mob.client);
  }
}

/**
 * Drive the create-character / login → in-world transition.
 * @param {*} state
 * @param {string | ReturnType<typeof parseCreateCharacter>} nameOrChoice
 */
function bringIntoWorld(state, nameOrChoice) {
  // Backwards compat: tests / older callers may still pass a bare name.
  const isCreateRequest = typeof nameOrChoice === 'object' && nameOrChoice !== null;
  const choice = isCreateRequest ? nameOrChoice
    : { name: nameOrChoice, sex: 0, profession: 0, str: 60, dex: 30, int: 10,
        skills: {}, skinHue: 0, hair: null, beard: null, shirtHue: 0, pantsHue: 0 };
  const name = choice.name;
  const world = state.ctx.world;

  // Returning player: rebind to the existing mobile if the account
  // already owns one. Skip this path entirely when the client sent
  // 0xF8 CreateCharacter — the user EXPLICITLY asked for a new
  // character; reusing the old mobile would silently throw away
  // every selection from the creator screen (sex, hue, skills, …)
  // and the user would log into the previous avatar instead.
  // The account binding is updated below to point at the new mob,
  // so subsequent 0x5D PlayCharacter flows return the fresh char.
  let mob = null;
  if (!isCreateRequest) {
    mob = resolvePlayerMobile(world, state);
  }

  if (mob) {
    // Safety net for genuinely invalid legacy saves only. Do not move a
    // valid existing character on login / createworld / wipeworld flows:
    // operators expect their avatar to stay exactly where it was.
    const STARTER_X = 1825, STARTER_Y = 2728, STARTER_Z = 0;
    // Jail enforcement — server parity #8 #10. [jail set `acc.jailed=true`
    // but bringIntoWorld never read the flag, so a jailed player just
    // logged back in and walked out. Re-bind to the jail cell on every
    // login until `[unjail` lifts the flag.
    if (state.account?.jailed) {
      const jx = parseInt(process.env.UO_JAIL_X ?? '5276', 10);
      const jy = parseInt(process.env.UO_JAIL_Y ?? '1164', 10);
      const jz = parseInt(process.env.UO_JAIL_Z ?? '0',    10);
      const jm = parseInt(process.env.UO_JAIL_MAP ?? '0',  10);
      mob.x = jx; mob.y = jy; mob.z = jz; mob.map = jm;
      console.log(`[net#${state.id}] jailed account ${state.account.username} rebound to (${jx},${jy})`);
    } else {
      if (mob.x === 0 || mob.y === 0) {
        console.log(`[net#${state.id}] respawning ${mob.name} from invalid coords (${mob.x},${mob.y}) -> starter`);
        mob.x = STARTER_X; mob.y = STARTER_Y; mob.z = STARTER_Z; mob.map = 1;
      }
    }
    // Returning player: make sure they still have a backpack. Earlier-version
    // bugs (or any future cleanup) could have stripped it; without one the
    // user has nowhere to stash items they pick up.
    ensureBackpack(world, mob);
    // BUGFIX #138 (FAZA JG): if the existing mobile is naked (any of
    // a few canonical clothing layers missing), re-equip the default
    // newbie outfit. Without this, players whose initial creator outfit
    // never landed (cold-boot before scripts registered, save round-
    // trip dropping the layer fields, etc.) reconnected naked forever.
    // Walk only the mob's worn slots via the reverse parent index —
    // O(|worn|) instead of full 110k items walk on every login. Bug-
    // hunt #2 drobiazgi.
    let hasAnyWearable = false;
    const wornIdx = world._childrenByParent?.get?.(mob.serial);
    if (wornIdx) {
      for (const s of wornIdx) {
        const it = world.items.get(s);
        if (it && (it.layer ?? 0) > 0 && it.layer !== 21) { hasAnyWearable = true; break; }
      }
    } else {
      for (const it of world.items.values()) {
        if (it.parent !== mob.serial) continue;
        if ((it.layer ?? 0) > 0 && it.layer !== 21) { hasAnyWearable = true; break; }
      }
    }
    if (!hasAnyWearable) outfitFreshMobile(world, mob);
  } else {
    // FAZA BR — apply the user's selections from the CreateCharacter packet.
    // Profession seeds default skills only when the user picked a preset
    // (profession > 0); the "Advanced" path (profession 0) lets the player
    // choose skills directly, which we honour via choice.skills.
    const advancedDefaults = {
      18: 30, 26: 30, 28: 30, 41: 30,
    };
    const skills = (choice.profession > 0 || Object.keys(choice.skills).length > 0)
      ? choice.skills
      : advancedDefaults;
    const female = choice.sex === 1;

    // ----- Validation (caps + name) -----------------------------------
    // Server-side gates so a doctored client can't bypass the in-game
    // creator's limits. We CLAMP rather than reject so the player still
    // gets in (kicking on bad caps would brick a legitimate user whose
    // chosen profession totals 226, etc).
    let str  = Math.max(10, Math.min(60,  choice.str  || 60));
    let dex  = Math.max(10, Math.min(60,  choice.dex  || 30));
    let intt = Math.max(10, Math.min(60,  choice.int  || 10));
    const STAT_TOTAL = 90;                  // ServUO modern new-char cap
    if (str + dex + intt > STAT_TOTAL) {
      const scale = STAT_TOTAL / (str + dex + intt);
      str  = Math.max(10, Math.floor(str  * scale));
      dex  = Math.max(10, Math.floor(dex  * scale));
      intt = Math.max(10, STAT_TOTAL - str - dex);
    }
    let skillSum = 0;
    for (const v of Object.values(skills)) skillSum += v | 0;
    const SKILL_TOTAL = 120;
    if (skillSum > SKILL_TOTAL && skillSum > 0) {
      const scale = SKILL_TOTAL / skillSum;
      for (const k of Object.keys(skills)) skills[k] = Math.max(0, Math.floor(skills[k] * scale));
    }
    const safeName = (() => {
      const reason = validateCharacterName(name);
      if (!reason) return name;
      console.warn(`[net] character create rejected name "${name}" — ${reason}; falling back to account name`);
      return state.accountName || 'Adventurer';
    })();

    // ----- Race / starter city ----------------------------------------
    const race = Math.max(0, Math.min(2, choice.race | 0));
    const body = bodyForRace(race, female);
    const raceName = raceNameFromCreatorIndex(race);
    const city = STARTER_CITIES[choice.cityIndex | 0] ?? STARTER_CITIES[0];
    const skinHue = normalizeCreatorSkinHue(race, choice.skinHue);

    mob = world.createMobile({
      name: safeName,
      body,
      hue: skinHue,
      sex: female ? 1 : 0,
      str, dex, int: intt,
      skills,
      x: city.x, y: city.y, z: city.z, map: city.map,
      gold: 1000,                  // ServUO starter gold
      race: raceName,
    });
    assignRace(mob, raceName);
    mob.hue = skinHue;
    // Stamp the player markers BEFORE anyone could read them. Both fields
    // round-trip through saves (see persistence.js MOBILE_EXT_KEYS) and
    // are what `resolvePlayerMobile` validates on the next login. Without
    // them a future spawn that happens to allocate the same serial would
    // be indistinguishable from a real player avatar — that was the root
    // cause of the "admin reconnects as a mature pixie" report.
    mob.isPlayer = true;
    mob.accountName = state.accountName ?? state.account?.username ?? null;
    mob.z = resolveStandingZ(mob.map, mob.x, mob.y, mob.z);

    // Equip the chosen profession's outfit. The clothing-presets script
    // registers an `[outfit` command that targets the same applyOutfit()
    // helper; we resolve a name from the profession byte and apply it
    // here so the player walks into the world already dressed.
    const presetName = presetFromProfession(choice.profession);
    applyOutfitForCreator(world, mob, presetName);

    // Hair + facial hair as worn items so the paperdoll renders them.
    if (choice.hair?.itemId && isValidCreatorHair(race, female, choice.hair.itemId)) {
      createItem(world, {
        itemId: choice.hair.itemId, hue: choice.hair.hue ?? 0,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        parent: mob.serial, layer: 11,
      });
    }
    if (choice.beard?.itemId && isValidCreatorBeard(race, female, choice.beard.itemId)) {
      createItem(world, {
        itemId: choice.beard.itemId, hue: choice.beard.hue ?? 0,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        parent: mob.serial, layer: 16,
      });
    }
    // Always end with a backpack on layer 21.
    const backpack = ensureBackpack(world, mob);

    // Starter loadout — ServUO `CharacterCreation.cs` drops these
    // into the backpack of every fresh character regardless of
    // profession. Item ids match the canonical UO templates.
    if (backpack) {
      try {
        // Scroll of Introduction (gump 0x0E34, generic scroll art).
        createItem(world, {
          itemId: 0x0E34, hue: 0, parent: backpack.serial,
          name: 'a scroll of introduction',
        });
        // Dagger — fallback weapon every newbie carries.
        createItem(world, {
          itemId: 0x0F52, hue: 0, parent: backpack.serial,
          name: 'a dagger',
        });
        // Candle — basic light source.
        createItem(world, {
          itemId: 0x0A28, hue: 0, parent: backpack.serial,
          name: 'a candle',
        });
        // Spellbook for mage / necromancer starters.
        if (presetName === 'mage' || presetName === 'necromancer') {
          createItem(world, {
            itemId: 0x0EFA, hue: 0, parent: backpack.serial,
            name: 'a spellbook', spellbook: true, spells: 0xFFFFFFFFFFFFFFFFn,
          });
        }
      } catch (e) {
        console.warn('[create] starter loadout failed:', e?.message || e);
      }
    }

    // Bank box on layer 0x1D + 1000 starter gold + a recall rune
    // template. Mirrors ServUO `CharacterCreation.AddBankbox`.
    try {
      const bank = createItem(world, {
        itemId: 0x09AB, hue: 0,
        parent: mob.serial, layer: 0x1D,
        // 0x004A is the canonical "BankBox" gump art in CUO
        // (Gumps.cs `Bankbox`). Was 0x003C (default backpack) so every
        // [bank command opened a backpack-shaped gump for what is
        // visually a wooden chest. Marcin: "skrzynia bankowa wygląda
        // jak plecak". Also see the layer-0x1D override at open-time
        // (handleDoubleClick) which back-fills the same gumpId for
        // pre-migration legacy banks already in `saves/`.
        gumpId: 0x004A,
        name: `${mob.name}'s bank box`,
      });
      createItem(world, {
        itemId: 0x0EED, hue: 0, amount: 1000,
        parent: bank.serial,
        name: 'gold',
      });
    } catch (e) {
      console.warn('[create] bank box init failed:', e?.message || e);
    }

    if (state.account) {
      state.account.mobileSerial = mob.serial >>> 0;
      state.ctx.accounts?.saveSync();
    }
  }

  mob.client = state;
  state.mobile = mob;
  state.ctx.world?.markMobileOnline?.(mob);
  syncMobileEquipmentIndex(world, mob);

  state.send(loginConfirm({
    serial: mob.serial,
    body: mob.body,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    direction: mob.direction,
    mapWidth: 6144,
    mapHeight: 4096,
  }));
  // 0x15 CharacterLocale — locale stamp (Britannia=1). Vanilla CUO ignores
  // unknown values; AOS clients use it for cliloc date formatting.
  state.send(characterLocale(mob.serial, 1));
  state.send(extMapPatches());
  state.send(extMapChange(mob.map));
  // Send the CURRENT season + light + weather to the new client so they
  // walk in mid-cycle correctly. Without these reads the world entered
  // at `loginComplete` was always full bright/dry/summer until the next
  // tick of the cycle (15s later), giving every login a brief flash.
  const dn = state.ctx.dayNight;
  state.send(seasonChange(dn?.season ?? 1, 1));
  state.send(overallLightLevel(dn?.currentLevel?.() ?? 0));
  // Re-emit personal light if the player relogged while holding a
  // lit torch / lantern. The torch/lantern script's `onEquip` fires
  // only on the equip event — a saved-and-restored equipped torch
  // arrives in `mob.equipment` without re-running onEquip, so the
  // halo was lost on every relog. Use the reverse parent→children
  // index (built by `createItem`/persistence-load) so we walk only
  // the player's direct children (~12 worn items) instead of all
  // ~85k world.items.
  try {
    const world = state.ctx?.world;
    const childSerials = world?._childrenByParent?.get?.(mob.serial);
    let bestLevel = 0;
    if (childSerials) {
      for (const s of childSerials) {
        const it = world.items?.get?.(s);
        if (!it || !it.layer || !it._lit) continue;
        // Light strength by script kind — mirrors broadcast.js
        // LIGHT_LEVEL table. Torches 9, lanterns 11, candle 6.
        const k = it.script;
        const lvl = k === 'lantern' ? 11
                  : k === 'candelabra' ? 11
                  : k === 'candle' ? 6
                  : k === 'torch' ? 9
                  : 0;
        if (lvl > bestLevel) bestLevel = lvl;
      }
    }
    if (bestLevel > 0) {
      state.send(personalLightLevel(mob.serial, bestLevel));
    }
  } catch { /* advisory */ }
  if (dn?.weatherKind != null && dn.weatherKind !== 0xFE) {
    state.send(weather({ kind: dn.weatherKind, intensity: dn.weatherIntensity ?? 0 }));
  }
  state.send(mobileUpdate({
    serial: mob.serial,
    body: mob.body,
    hue: mob.hue,
    flags: mob.flags,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    direction: mob.direction,
  }));
  state.send(mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue, flags: mob.flags, notoriety: mob.notoriety,
    equipment: equipmentFor(state.ctx.world, mob),
  }));
  state.send(healthUpdate({ serial: mob.serial, current: mob.hp ?? 50, max: mob.hpMax ?? 50 }));
  // Push mana + stamina alongside HP on initial login — without these
  // packets the client's HealthBarGump for self renders empty M/S wells
  // until the next status request round-trip (which only happens on
  // explicit gump click). Mages would log in seeing "0 mana" and assume
  // the bar was broken. The status-request path at line ~3162 already
  // emits all three; mirror that here so the bar fills immediately.
  state.send(manaUpdate({ serial: mob.serial, current: mob.mana ?? 50, max: mob.manaMax ?? 50 }));
  state.send(staminaUpdate({ serial: mob.serial, current: mob.stam ?? 50, max: mob.stamMax ?? 50 }));
  // Stat-lock initial state — without this push the client renders the
  // 3 lock toggles (str/dex/int) on the status gump as "up" arrows
  // unconditionally; the persisted server state only applies after the
  // first 0xBF 0x1A round-trip.
  {
    const sl = mob.statLocks ?? { str: 0, dex: 0, int: 0 };
    state.send(extExtendedStats(mob.serial, sl.str | 0, sl.dex | 0, sl.int | 0));
  }
  state.send(loginComplete());
  state.send(clientVersionRequest());
  state.send(unicodeMessage({ text: `Welcome to ${state.ctx.config.shardName}!` }));

  // Shard command catalogue — push the filtered list of chat commands
  // so the client renders the right-edge "commands" panel. Re-pushed
  // on script hot-reload via `pushCommandCatalogueToAll` below.
  pushCommandCatalogue(state);

  // Stream existing nearby mobiles and items to the new player, and announce
  // the new player to them. Same one-shot equipment index as
  // refreshSurroundings — avoids 50× full world.items walk on join.
  const equipByOwner = buildEquipByOwner(state.ctx.world);
  // Reset visibility cache — login is the canonical "you know about
  // nothing yet" baseline. `streamVisibilityDelta` diffs against this.
  state._visibleItems  = new Set();
  state._visibleMobiles = new Set();
  for (const other of nearbyClients(state.ctx.world, mob, mob)) {
    state.send(mobileIncoming({
      serial: other.serial, body: other.body, x: other.x, y: other.y, z: other.z,
      direction: other.direction, hue: other.hue, flags: other.flags, notoriety: other.notoriety,
      equipment: equipmentFor(state.ctx.world, other, equipByOwner),
    }));
    state.send(healthUpdate({ serial: other.serial, current: other.hp ?? 50, max: other.hpMax ?? 50 }));
    state._visibleMobiles.add(other.serial >>> 0);
    other.client.send(mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue, flags: mob.flags, notoriety: mob.notoriety,
      equipment: equipmentFor(state.ctx.world, mob, equipByOwner),
    }));
    other.client.send(healthUpdate({ serial: mob.serial, current: mob.hp ?? 50, max: mob.hpMax ?? 50 }));
  }
  for (const item of nearbyItems(state.ctx.world, mob)) {
    state.sendItem(item);
    state._visibleItems.add(item.serial >>> 0);
  }

  state.stage = Stage.InWorld;
  // FAZA DC: push virtue snapshot so the Ctrl+V gump renders the
  // persisted values (otherwise it shows 0 on every login until the
  // next awardVirtue call).
  try {
    state.ctx?.systems?.virtues?.pushVirtues?.(mob);
  } catch (e) {
    console.error('[net] virtue push failed:', e);
  }
  // Daily login reward — first login of a UTC day gets a streak-scaled
  // gift dropped into backpack. Bug-hunt #5 NEW feature.
  try {
    const dl = state.ctx?.systems?.dailyLogin;
    if (dl?.checkAndGrantDailyReward && state.account) {
      const res = dl.checkAndGrantDailyReward(state.ctx.world, mob, state.account);
      if (res?.granted) {
        state.ctx.accounts?.saveSync?.();
      }
    }
  } catch (e) {
    console.error('[net] daily login reward failed:', e);
  }
  // Anniversary cumulative reward — account-age tier crossings drop a
  // commemorative item into pack (1y token → 30y throne). Idempotent
  // per (account, gift).
  try {
    const ann = state.ctx?.systems?.anniversary;
    if (ann?.grantPending && state.account) {
      const granted = ann.grantPending(state.ctx.world, mob, state.account);
      if (granted?.length) state.ctx.accounts?.saveSync?.();
    }
  } catch (e) {
    console.error('[net] anniversary reward failed:', e);
  }
  // Seasonal gift box — within Yule/Easter/Halloween/Anniversary window,
  // first login during that window drops the matching gift basket.
  try {
    const gg = state.ctx?.systems?.giftGiving;
    if (gg?.tryDeliver) {
      const gift = gg.tryDeliver(state.ctx.world, mob);
      if (gift) {
        const pack = mob && state.ctx.world.items.values
          ? Array.from(state.ctx.world.items.values()).find(
              (it) => it.parent === mob.serial && it.layer === 21,
            )
          : null;
        if (pack && state.ctx.world.createItem) {
          state.ctx.world.createItem({
            itemId: 0x09AA, name: gift.gift, parent: pack.serial,
          });
          mob.client?.sendSystemMessage?.(`A seasonal gift has been placed in your backpack: ${gift.gift}.`);
        }
      }
    }
  } catch (e) {
    console.error('[net] seasonal gift failed:', e);
  }
  console.log(`[net#${state.id}] ${mob.name} (${mob.serial.toString(16)}) entered world`);
}

function handleExtendedCommand(state, pkt) {
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16(); // opcode + length
  const sub = r.readU16();
  if (sub === 0x0015) {
    // Context menu request — dispatch via the contextMenus registry.
    const serial = r.readU32();
    handleContextMenuRequest(state, serial);
    return;
  }
  if (sub === 0x0016) {
    // Context menu response.
    const serial = r.readU32();
    const responseId = r.readU16();
    handleContextMenuResponse(state, serial, responseId);
    return;
  }
  if (sub === 0x0006) {
    handlePartyCommand(state, pkt);
    return;
  }
  if (sub === 0x0028) {
    handleGuildMessage(state, pkt);
    return;
  }
  if (sub === 0x0005) {
    // ScreenSize — client reports its viewport in tiles. ServUO uses it
    // for `Mobile.UpdateRange`; we cap at 18 for fairness with non-CUO
    // clients but still record so debug commands can read it.
    if (r.remaining >= 6) {
      r.readU16();              // unknown (always 0)
      const w = r.readU16();
      const h = r.readU16();
      state.screenW = w | 0;
      state.screenH = h | 0;
    }
    return;
  }
  if (sub === 0x000B) {
    // Language — 4 ASCII chars, e.g. 'ENU'. Stash on state for region
    // text dispatch (cliloc lookup).
    if (r.remaining >= 4) state.language = r.readAsciiFixed(4);
    return;
  }
  if (sub === 0x000C) {
    // CloseStatusGump (server-side echo) — client confirming it closed
    // a status window. Nothing to do server-side.
    return;
  }
  if (sub === 0x000F) {
    // Empty (heartbeat) — UO Razor pings.
    return;
  }
  if (sub === 0x0010) {
    // QueryProperties — single OPL hash check. Synthesise a minimal
    // 0xD6 BatchQueryProperties packet (one serial) and let the regular
    // OPL handler emit the 0xDC reply.
    if (r.remaining < 4) return;
    const serial = r.readU32() >>> 0;
    const buf = new Uint8Array(9);
    buf[0] = 0xD6; buf[1] = 0x00; buf[2] = 0x09;
    buf[3] = (serial >>> 24) & 0xff; buf[4] = (serial >>> 16) & 0xff;
    buf[5] = (serial >>> 8)  & 0xff; buf[6] = serial & 0xff;
    try { handleOPLRequest(state, buf); }
    catch (e) { console.error('[ext 0x10 QueryProperties] failed:', e.message); }
    return;
  }
  if (sub === 0x001A) {
    // StatLockChange — client clicking the lock-cycle button on the
    // status gump. CUO `Network/OutgoingPackets.cs::StatLockChangeRequest`
    // sends only 2 bytes after the subop: u8 stat (0=str/1=dex/2=int) +
    // u8 lock (0=up, 1=down, 2=locked). Always for the player mobile.
    if (r.remaining < 2) return;
    const stat = r.readU8();
    const lock = r.readU8() & 0x03;
    const mob = state.mobile;
    if (!mob) return;
    mob.statLocks ??= { str: 0, dex: 0, int: 0 };
    const k = stat === 0 ? 'str' : stat === 1 ? 'dex' : stat === 2 ? 'int' : null;
    if (!k) return;
    mob.statLocks[k] = lock;
    // Echo back so client can confirm — the 0xBF 0x19 SetStatLock packet
    // pushes all three lock states at once.
    state.send(extExtendedStats(mob.serial,
      mob.statLocks.str | 0, mob.statLocks.dex | 0, mob.statLocks.int | 0));
    return;
  }
  if (sub === 0x001C) {
    // CastSpell (UI-driven). Layout: u16 spellId. Optional book serial
    // u32 follows for a bookless macro cast (0xFFFFFFFF). Some clients
    // include 4 bytes of "spell flags" before the id — skip if present.
    if (r.remaining < 2) return;
    const spellId = r.readU16();
    if (!state.mobile) return;
    // BUGFIX: prior implementation called castSpell with positional
    // args (world, caster, spellId, opts) but castSpell's signature is
    // a single context object — the world arg landed where ctx should
    // be, getSpell(ctx.spellId) saw `undefined`, and EVERY 0xBF 0x1C
    // cast silently failed with reason='unknown-spell'. Worse, the
    // failure path never cleared the cast lock the client had just
    // armed, so the next cast attempt was suppressed by the same
    // stale lock — Marcin's "Flamestrike blocked all spells" report.
    // Route through the same code path the 0x12 / 0x56 handler uses
    // so reagents, mana, target picker, fizzle math are all consistent.
    try {
      dispatchCastFromMacro(state, spellId);
    } catch (e) {
      console.error('[ext 0x1C CastSpell] failed:', e.message);
    }
    return;
  }
  if (sub === 0x002C) {
    // BandageTarget — 0xBF macro for using a bandage on a target without
    // the lift+drop dance. Layout: u32 bandageSerial + u32 targetSerial.
    if (r.remaining < 8) return;
    const bandageSerial = r.readU32() >>> 0;
    const targetSerial  = r.readU32() >>> 0;
    if (!state.mobile) return;
    const bandage = state.ctx.world.items.get(bandageSerial);
    const target  = state.ctx.world.mobiles.get(targetSerial)
                  ?? state.ctx.world.items.get(targetSerial);
    if (!bandage || !target) {
      state.sendSystemMessage?.('That bandage or target is gone.');
      return;
    }
    // Hand off to the bandage script — it owns the heal/cure/timer logic.
    try {
      dispatchItemEvent(state.ctx.world, bandage, 'onTarget',
        { user: state.mobile, target });
    } catch (e) {
      console.error('[ext 0x2C BandageTarget] failed:', e.message);
    }
    return;
  }
  if (sub === 0x0032) {
    // ToggleFlying — Gargoyle race ability. Flips the Flying flag on
    // the player mobile and broadcasts a 0x77 so observers see the
    // hover/landing animation. ServUO restricts to gargoyles only.
    const mob = state.mobile;
    if (!mob) return;
    if (mob.race !== 'gargoyle' && mob.body !== 0x029A && mob.body !== 0x029B) {
      state.sendSystemMessage?.('Only gargoyles may fly.');
      return;
    }
    mob.flying = !mob.flying;
    // CUO Mobile.cs: flying uses bit 0x04 of the *secondary* flags byte
    // exposed via 0x77's "flags" slot — easiest is to repurpose the
    // hidden 0x40 bit (already used) or stamp a custom bit visible to
    // our client only. We use bit 0x10 (Flying) which CUO recognises.
    const FLY_BIT = 0x10;
    mob.flags = mob.flying ? ((mob.flags | 0) | FLY_BIT) : ((mob.flags | 0) & ~FLY_BIT);
    try {
      const moving = mobileMoving({
        serial: mob.serial, body: mob.body,
        x: mob.x, y: mob.y, z: mob.z,
        direction: mob.direction ?? 0, hue: mob.hue ?? 0,
        flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
      });
      for (const o of state.ctx.world.mobiles.values()) {
        if (!o.client) continue;
        if (o.map !== mob.map) continue;
        if (Math.abs(o.x - mob.x) > 18 || Math.abs(o.y - mob.y) > 18) continue;
        o.client.send(moving);
      }
    } catch (e) {
      console.error('[ext 0x32 ToggleFlying] broadcast failed:', e.message);
    }
    return;
  }
  // Most sub-commands are either heartbeat-y (screen size, language) or
  // ===================================================================
  //  Tier-2 0xBF subop coverage. Each block is a 1-LOC handler that
  //  either echoes / records / no-ops a packet so we don't surface a
  //  "BF sub=0x.." log line for benign client chatter (Razor pings,
  //  newer-client extensions). Server→client subops (0x14, 0x19, 0x1B,
  //  0x21, 0x22, 0x25) are emitted from elsewhere — only client→server
  //  inbound subops live here.
  // ===================================================================

  if (sub === 0x0007) {
    // Razor / classic-style "request walk-cleanup" on resync. ServUO
    // ignores the payload; we mirror that behaviour. Surfacing a
    // movement-related event here just lets the AI / region tracker
    // see that the player explicitly resynced.
    return;
  }
  if (sub === 0x0008) {
    // ChangeMap (Felucca <-> Trammel travel command). Layout: u8 facet.
    if (r.remaining < 1) return;
    const facet = r.readU8() & 0xff;
    const mob = state.mobile;
    if (mob && (facet === 0 || facet === 1)) {
      mob.map = facet;
      // Re-broadcast 0x76 MapChange + 0x73 SeasonChange so the client
      // re-paints its facet. Best-effort — minor clients self-detect.
    }
    return;
  }
  if (sub === 0x0009) {
    // Wrestling Disarm — ServUO `WrestlingDisarm.cs`. Requirements: the
    // attacker must hold no weapon (bare hands) AND have Wrestling >=80
    // AND not be on a per-mob cooldown (10s). On the next successful
    // melee swing the target's wielded weapon falls into their pack.
    //
    // We stamp `_pendingDisarm` on the attacker; combat-formulas.js
    // /handleHitEvent reads the flag at hit-time and (a) consumes it,
    // (b) disarms the defender, (c) resets the 10s cooldown.
    const mob = state.mobile;
    if (!mob) return;
    const wrest = effectiveSkill(mob, 44);             // skill id 44 = Wrestling
    if (wrest < 80) {
      state.sendSystemMessage?.('You are not skilled enough to attempt this attack.');
      return;
    }
    const wielded = mob.equipment?.get?.(1) ?? mob.equipment?.get?.(2);
    if (wielded) {
      state.sendSystemMessage?.('You cannot disarm with a weapon in hand.');
      return;
    }
    const now = Date.now();
    if (mob._disarmCooldownUntil && now < mob._disarmCooldownUntil) {
      state.sendSystemMessage?.('You must wait a moment before attempting this again.');
      return;
    }
    mob._pendingDisarm = now + 4000;                    // 4s window to land the hit
    mob._disarmCooldownUntil = now + 10_000;
    state.sendSystemMessage?.('You ready your next blow as a disarming attack.');
    return;
  }
  if (sub === 0x000A) {
    // Wrestling Stun — ServUO `WrestlingStun.cs`. Same gate as Disarm
    // (bare hands + Wrestling >=80 + 10s cooldown) but the on-hit effect
    // freezes the target for 4 seconds via the existing paralyze flag.
    const mob = state.mobile;
    if (!mob) return;
    const wrest = effectiveSkill(mob, 44);
    if (wrest < 80) {
      state.sendSystemMessage?.('You are not skilled enough to attempt this attack.');
      return;
    }
    const wielded = mob.equipment?.get?.(1) ?? mob.equipment?.get?.(2);
    if (wielded) {
      state.sendSystemMessage?.('You cannot stun with a weapon in hand.');
      return;
    }
    const now = Date.now();
    if (mob._stunCooldownUntil && now < mob._stunCooldownUntil) {
      state.sendSystemMessage?.('You must wait a moment before attempting this again.');
      return;
    }
    mob._pendingStun = now + 4000;
    mob._stunCooldownUntil = now + 10_000;
    state.sendSystemMessage?.('You ready your next blow as a stunning attack.');
    return;
  }
  if (sub === 0x000E) {
    // Snoop/spy ack — client confirms it processed the snoop window.
    return;
  }
  if (sub === 0x0013) {
    // Legacy ContextMenuRequest (some 7.0.x clients emit it instead of
    // 0x15). Same body — forward to the same dispatcher.
    if (r.remaining < 4) return;
    const serial = r.readU32();
    handleContextMenuRequest(state, serial);
    return;
  }
  if (sub === 0x0017) {
    // Codex of Wisdom (right-click "?" on UI elements). Layout: u32 cliloc.
    // Server may push back a 0xBF 0x17 with the help text — we just record
    // for telemetry.
    if (r.remaining >= 4) {
      const cliloc = r.readU32();
      state._lastCodexQuery = cliloc;
    }
    return;
  }
  if (sub === 0x0018) {
    // EnableMapDiff — modern client signals it understands map-patch
    // updates. We always send full-map data, so accept and ignore.
    return;
  }
  if (sub === 0x0021) {
    // ClearWeaponAbilities — client wants to drop both primary +
    // secondary special-move slots. Mirrors ServUO `WeaponAbility.ClearCurrentAbility`.
    const mob = state.mobile;
    if (mob) {
      mob._primaryAbility = null;
      mob._secondaryAbility = null;
    }
    return;
  }
  if (sub === 0x0024) {
    // UnknownF6 — modern-client interaction confirm. ServUO no-ops it.
    return;
  }
  if (sub === 0x002B) {
    // Audit #46 P2 — ChangeRace reply from client. Layout:
    //   raceId(u8) + sex(u8) + answer(u8)
    // Audit rev.9 P2 #1 — extended payload appended when the client
    // ships the full appearance picker:
    //   skinHue(u16) + hairId(u16) + hairHue(u16) + beardId(u16) + beardHue(u16)
    // The reader is length-tolerant: missing trailing fields default to 0.
    if (r.remaining < 3) return;
    const raceId = r.readU8();
    const sex    = r.readU8();
    const answer = r.readU8();
    let skinHue = 0, hairId = 0, hairHue = 0, beardId = 0, beardHue = 0;
    if (r.remaining >= 10) {
      skinHue  = r.readU16();
      hairId   = r.readU16();
      hairHue  = r.readU16();
      beardId  = r.readU16();
      beardHue = r.readU16();
    }
    const mob = state.mobile;
    if (!mob || !answer) return;
    if (raceId < 1 || raceId > 3) return;
    // Pending flag: must have been server-armed (we set _pendingRaceChange
    // when sending the 0x2A prompt; without it this is a spoofed reply).
    if (!mob._pendingRaceChange) {
      state.sendSystemMessage?.('Race change is not currently available.');
      return;
    }
    const BODIES = {
      1: { male: 400, female: 401 },
      2: { male: 605, female: 606 },
      3: { male: 666, female: 667 },
    };
    const female = !!sex;
    const createRace = Math.max(0, Math.min(2, raceId - 1));
    const raceName = raceNameFromCreatorIndex(createRace);
    mob.female = female;
    assignRace(mob, raceName);
    mob.body   = BODIES[raceId][female ? 'female' : 'male'];
    if (skinHue) mob.hue = normalizeCreatorSkinHue(createRace, skinHue);
    mob._pendingRaceChange = 0;
    // Audit rev.9 P2 #14 — re-equip paperdoll items into pack when they
    // no longer match the new race's slot map. Gargoyles can't wear
    // helmets / chest plate; humans/elves can't wear Wings. We move
    // mismatched items to the backpack instead of destroying them.
    try {
      const RACE_VALID_LAYERS = {
        1: new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]),
        2: new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]),
        // Gargoyle: drops helmet(6), face(12), feet(3), pants(4), legs(13).
        // Adds wings(24 reused for stomach? — keep generic full set; server
        //   side artwork filter happens in the equip path).
        3: new Set([1,2,5,7,8,9,10,11,14,15,16,17,18,19,20,21,22,23,24]),
      };
      const allowed = RACE_VALID_LAYERS[raceId] ?? RACE_VALID_LAYERS[1];
      const items = Array.from(mob.equipped?.values?.() ?? []);
      for (const it of items) {
        if (!it?.layer || allowed.has(it.layer)) continue;
        // Move to backpack — find the backpack item.
        const pack = mob.findBackpack?.();
        if (!pack) continue;
        try {
          mob.unequip?.(it.layer);
          pack.addItem?.(it);
        } catch { /* swallow item-state errors */ }
      }
    } catch { /* best-effort */ }
    // Apply hair / facial-hair / beard ids (server-side virtual items
    // on layers 11 + 16). We replace if existing.
    try {
      const equipHair = (layer, itemId, hue) => {
        if (!itemId) return;
        mob.equipHairOrBeard?.(layer, itemId, hue);
      };
      if (hairId && isValidCreatorHair(createRace, female, hairId)) equipHair(11, hairId,  hairHue);
      // Female gargoyles + female humans normally lack a beard slot;
      // we silently drop beardId when sex=female unless the shard
      // overrides via `mob.allowFemaleBeard`.
      if (beardId && (mob.allowFemaleBeard || isValidCreatorBeard(createRace, female, beardId))) equipHair(16, beardId, beardHue);
    } catch { /* best-effort */ }
    // Broadcast updated body/hue to neighbours.
    try {
      const moving = mobileMoving({
        serial: mob.serial, body: mob.body,
        x: mob.x, y: mob.y, z: mob.z,
        direction: mob.direction ?? 0, hue: mob.hue ?? 0,
        flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
      });
      for (const o of state.ctx.world.mobiles.values()) {
        if (!o.client) continue;
        if (o.map !== mob.map) continue;
        if (Math.abs(o.x - mob.x) > 18 || Math.abs(o.y - mob.y) > 18) continue;
        o.client.send(moving);
      }
    } catch { /* best-effort */ }
    state.sendSystemMessage?.(`Race changed to ${['', 'Human', 'Elf', 'Gargoyle'][raceId]}.`);
    return;
  }
  if (sub === 0x002E) {
    // EquipMacro — Razor "equip last weapon" macro. Layout: u8 count +
    // count×u32 item serials. We pipe through the standard handleWearItem
    // for each (silently skips ones not in the player's pack).
    if (r.remaining < 1) return;
    const count = r.readU8();
    const mob = state.mobile;
    if (!mob) return;
    for (let i = 0; i < count; i++) {
      if (r.remaining < 4) break;
      const itemSerial = r.readU32() >>> 0;
      const item = state.ctx.world.items.get(itemSerial);
      if (item && item.parent === mob.serial && item.layer != null) {
        // Existing wear-item path — mob equips the layer.
        try { handleWearItemForce?.(state, item); }
        catch { /* fallback: stamp parent + layer */ setItemParent(state.ctx.world, item, mob.serial); }
      }
    }
    return;
  }
  if (sub === 0x002F) {
    // UnequipMacro — symmetrical to 0x2E. Strips items from the listed
    // layers + drops them into the player's pack.
    if (r.remaining < 1) return;
    const count = r.readU8();
    const mob = state.mobile;
    if (!mob) return;
    const pack = mob.equipment?.get?.(21);
    for (let i = 0; i < count; i++) {
      if (r.remaining < 1) break;
      const layer = r.readU8();
      const worn = mob.equipment?.get?.(layer);
      if (worn && pack) {
        setItemParent(state.ctx.world, worn, pack.serial >>> 0);
        worn.layer = null;
        mob.equipment.delete(layer);
      }
    }
    return;
  }
  if (sub === 0x0030) {
    // TargetByResourceMacro — equip-by-resource-type. Client sends:
    //   u16 sub=0x0030, u32 mobileSerial, u8 resourceType, u16 graphic
    // We resolve the first item in the player's pack matching
    // (graphic) and (resource hue) and equip it. Used by miners
    // who macro "equip by ore color" (valorite/agapite/gold/etc).
    if (r.remaining < 7) return;
    const _mobSer = r.readU32();
    const resourceType = r.readU8();
    const graphic = r.readU16();
    const mob = state.mobile;
    if (!mob) return;
    // ServUO `Resources` table: 0=iron, 1=dull, 2=shadow, 3=copper,
    // 4=bronze, 5=gold, 6=agapite, 7=verite, 8=valorite.
    const RESOURCE_HUE = [0, 0x0972, 0x0966, 0x097B, 0x0972, 0x08A5, 0x0979, 0x089F, 0x08AB];
    const wantHue = RESOURCE_HUE[resourceType] ?? 0;
    let found = null;
    for (const it of state.ctx.world.items.values()) {
      if (it.parent !== mob.serial) continue;
      if (it.itemId !== graphic) continue;
      if (wantHue && it.hue !== wantHue) continue;
      found = it; break;
    }
    if (found && found.layer != null) {
      // Already equipped? Bail to avoid double-equip.
      const cur = mob.equipment?.get?.(found.layer);
      if (cur !== found) {
        setItemParent(state.ctx.world, found, mob.serial);
      }
    }
    return;
  }
  if (sub === 0x002D) {
    // TargetedSpell — Razor/CUO macro that casts a spell with a target
    // pre-filled, skipping the cursor step. ServUO
    // `Misc/ProtocolExtensions.cs::OnTargetedSpell`. Layout:
    //   u16 sub=0x002D, u16 spellId, u32 targetSerial
    // We arm a one-shot pending-target on the caster, then dispatch
    // the spell — when the spell wants a target it consumes our stash
    // instead of opening a cursor.
    if (r.remaining < 6) return;
    const spellId = r.readU16();
    const targetSerial = r.readU32() >>> 0;
    const mob = state.mobile;
    if (!mob) return;
    mob._pendingMacroTargetSerial = targetSerial;
    try {
      dispatchCastFromMacro(state, spellId);
    } catch (e) {
      console.error('[ext 0x2D TargetedSpell] failed:', e.message);
    } finally {
      // Clear after one cast attempt — the spell's target-picker either
      // consumed it or it's gone stale.
      delete mob._pendingMacroTargetSerial;
    }
    return;
  }
  if (sub === 0x0033) {
    // ServerOpenedQueryHelp — client confirming the help dialog opened.
    return;
  }
  if (sub === 0x0040) {
    // KeyConfirm — client confirms it received our 0xC1 cliloc-key
    // packet. No-op.
    return;
  }

  // client-to-server acks we can ignore for MVP. Log unknowns when enabled.
  if (state.ctx.config.logPackets) {
    console.log(`[net#${state.id}] BF sub=0x${sub.toString(16)}`);
  }
}

// EquipMacro path: optional helper that wraps the standard wear-item
// handler when one is exported. Defensive bind — if the project ever
// stops exporting `handleWearItem`, the EquipMacro call falls back to
// just stamping the layer.
const handleWearItemForce = null;

function handleMovementReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) {
    trace('move', `net#${state.id}: rejected — stage=${state.stage} mobile=${!!state.mobile}`);
    return;
  }
  const r = new PacketReader(pkt);
  r.readU8();
  const direction = r.readU8();
  const sequence = r.readU8();
  r.readU32(); // fastWalk key (unused)
  trace('move', `net#${state.id} recv: dir=0x${direction.toString(16)} seq=${sequence} at=(${state.mobile.x},${state.mobile.y},${state.mobile.z})`);

  // Direction layout: low 3 bits = facing (0..7), 0x80 = running.
  // Bits 0x08/0x10/0x20/0x40 should always be zero — UO uses only the
  // facing nibble and the run flag. Any reserved bit set means a
  // previous over-reading packet drifted the framer into the middle
  // of a 0xB1 GumpResponse or similar, and what we're parsing as a
  // MovementReq is actually 7 bytes of foreign payload. Reject WITHOUT
  // snap-back so the player doesn't tele-back to their last spot every
  // time this happens (user report 2026-05-19 framer-drift wave on
  // gump button press). The framer's resync skip-1-byte path will
  // pick up the real packet on the next chunk.
  if ((direction & 0x78) !== 0) {
    if (!state._driftWarnAt || Date.now() - state._driftWarnAt > 5000) {
      console.warn(`[net#${state.id}] handleMovementReq: invalid direction byte 0x${direction.toString(16)} (reserved bits set) — likely framer drift; ignoring`);
      state._driftWarnAt = Date.now();
    }
    trace('move', `net#${state.id} REJECT: reserved bits in direction 0x${direction.toString(16)}`);
    return;
  }
  const running = (direction & 0x80) !== 0;
  const facing = direction & 0x07;

  const mob = state.mobile;

  // Movement sequence ring-counter — ServUO uses an 8-bit sequence
  // number that increments per step (wraps 1..255, skip 0). We track
  // the last accepted seq and reject anything that's not the next in
  // sequence — replay protection. Bug-hunt #2 C3.
  const expected = ((state._lastMoveSeq | 0) + 1) & 0xff || 1;
  if (sequence !== 0 && sequence !== expected
      && state._lastMoveSeq != null) {
    // Out-of-order seq → snap-back + reset the counter. Don't disconnect
    // (a brief packet reorder over jittery WiFi can trip this).
    trace('move', `net#${state.id} REJECT seq: got=${sequence} expected=${expected}`);
    state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
    // Recover to the incoming sequence so follow-up packets can continue
    // from `sequence + 1` instead of getting stuck in a permanent reject loop.
    state._lastMoveSeq = sequence;
    return;
  }
  state._lastMoveSeq = sequence;

  // Speed-hack guard — ServUO `Mobile.OnBeforeMove` enforces a
  // minimum delta between successive steps. Walking ~400 ms, running
  // ~200 ms. Pure-turn requests (different facing, same tile) are
  // exempt — only actual steps tick the timer. GM/Admin bypass for
  // testing. Soft-reject with snap-back (legit lag also trips this).
  // Bug-hunt #2 C1.
  const accessLevel = state.account?.accessLevel;
  const isStaffMove = accessLevel === 'GM' || accessLevel === 'Admin' || accessLevel === 'Seer';
  if (!isStaffMove && (mob.direction & 0x07) === facing) {
    const now = Date.now();
    const last = mob._lastMoveAt ?? 0;
    const minDelta = running ? 180 : 380;
    if (last && (now - last) < minDelta) {
      trace('move', `net#${state.id} REJECT speed-hack: dt=${now - last}ms minDelta=${minDelta}ms`);
      state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
      return;
    }
    mob._lastMoveAt = now;
  }

  // Paralyzed players can't turn or move. Reject the request so the client
  // snaps back to its last known tile; the status-effects sweeper removes
  // 'paralyze' on expiry (or the player is cured).
  if (mob.effects?.some((e) => e.name === 'paralyze')) {
    trace('move', `net#${state.id} REJECT paralyzed`);
    state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
    return;
  }
  // Whispering Rose daze (Mastery passive) — short 4 s mobility lock.
  // Unlike paralyze, daze doesn't block spell casting — only walking.
  if ((mob._dazedUntil ?? 0) > Date.now()) {
    trace('move', `net#${state.id} REJECT dazed`);
    state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
    return;
  }
  // GM `[freeze` toggle — same wire effect as paralyze (rejection snaps
  // the client back) but persists until manually thawed by `[unfreeze`.
  if (mob.frozen) {
    state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
    return;
  }
  // Audit #36 P1 #3 — ServUO `Spell.cs:346 CheckMovement` returns false
  // while the caster has an active cast bar. Was: any caster could
  // run freely during their cast — PvP kiting was trivial and PvE
  // bosses couldn't reliably hit a fleeing mage. Allow turning
  // (handled below) but reject actual displacement during the cast.
  // Staff (GM/Admin) bypass for testing.
  const isStaff = state.account?.accessLevel === 'GM'
               || state.account?.accessLevel === 'Admin';
  if (!isStaff && mob._castTimer && (mob.direction & 0x07) === facing) {
    trace('move', `net#${state.id} REJECT casting`);
    state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
    state.sendSystemMessage?.('You cannot move while casting.');
    return;
  }

  // If we're just turning in place (different facing than current), no move.
  if ((mob.direction & 0x07) !== facing) {
    mob.direction = direction;
    state.send(movementAck(sequence, mob.notoriety));
    trace('move', `net#${state.id} ACK turn-only: now facing ${facing}`);
    return;
  }

  // Compute the target tile and ask the walkability resolver what z we'd
  // land on. A null result means the step is blocked — we reject and snap
  // the client back to its last known position.
  const [dx, dy] = DIRECTION_DELTAS[facing];
  const nx = (mob.x + dx) & 0xffff;
  const ny = (mob.y + dy) & 0xffff;
  const nz = resolveStep(mob.map, mob.x, mob.y, mob.z, nx, ny);
  if (nz == null) {
    trace('move', `net#${state.id} REJECT walkability: target=(${nx},${ny}) from=(${mob.x},${mob.y},${mob.z}) blocked`);
    state.send(movementRej({ sequence, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction }));
    return;
  }
  trace('move', `net#${state.id} ACK step: (${mob.x},${mob.y},${mob.z}) -> (${nx},${ny},${nz})`);
  // FAZA BQ: capture pre-step tile so the lifecycle dispatcher can fire
  // onWalkOff for the source and onWalkOn for the destination — the
  // hooks that drive spike-traps, pressure plates, teleporter pads.
  const fromTile = { x: mob.x, y: mob.y, z: mob.z, map: mob.map };
  const oldZ = mob.z;
  const prevX = mob.x;
  const prevY = mob.y;
  mob.x = nx;
  mob.y = ny;
  mob.z = nz;
  mob.direction = direction;
  // Archery draw reset — ServUO `BaseRanged.OnSwingMobile` re-arms the
  // draw timer whenever the wielder moves. Combat tick gates ranged
  // swings on `_archeryDrawUntil`. Cheap stamp, no allocation.
  if ((mob._weapon?.range ?? 1) > 1) {
    mob._archeryDrawUntil = Date.now() + 1000;
  }
  // Re-bucket the mobile in the sector index. No-op when staying in the
  // same 8×8 sector (cheap key compare).
  state.ctx?.world?.sectors?.moveMobile(mob);
  // Ack the accepted step before any visibility/region/script fan-out.
  // Sector crossing can stream dozens of items/mobiles; placing 0x22 after
  // that backlog made clients hit their 3s movement watchdog even though
  // the step was already committed server-side.
  state.send(movementAck(sequence, mob.notoriety));
  // Stream items + mobs newly entering visibility range, and 0x1D
  // removeEntity for those leaving. Without this, items spawned past
  // the initial visibility window (e.g. `[createworld` decorations on
  // the horizon after a fresh login or `[go` teleport) never reach the
  // client until they teleport away and back — user report 2026-05-18
  // "jak idziemy dalej to już nie ma drzwi ani znaków ani dekoracji".
  streamVisibilityDelta(state, mob, prevX, prevY);
  // Region OnEnter / OnLeave dispatch — ServUO `Region.OnEnter` is the
  // canonical hook for town guards, region greetings, anti-PvP zones,
  // music swap, etc. Server parity #7 P1: hooks existed but `updateRegion`
  // was never called from any movement path. Fire it now.
  try {
    const regions = state.ctx?.regions;
    const dispatcher = state.ctx?.regionOnEnter;
    if (regions?.primary && dispatcher?.updateRegion) {
      dispatcher.updateRegion(
        mob,
        (m) => regions.primary(m.map, m.x, m.y)?.name ?? null,
        { world: state.ctx.world, ctx: state.ctx },
      );
    }
  } catch (e) { console.error('[net] region dispatch failed:', e); }
  // Z-correction echo: 0x22 movementAck carries no z field, and the
  // client's local standing-Z resolver may diverge from ours when
  // statics are partially loaded or tiledata flags differ. Whenever
  // the step changed elevation, push a self-targeted 0x77 mobileMoving
  // so the client snaps the avatar to authoritative z without waiting
  // for the next cross-client broadcast. Mirrors what ServUO ends up
  // doing implicitly on the next tick when the player turns.
  if (nz !== oldZ) {
    state.send(mobileMoving({
      serial: mob.serial, body: mob.body,
      x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue,
      flags: mob.flags ?? 0, notoriety: mob.notoriety,
    }));
  }
  // Stamina drain — ServUO `Mobile.OnBeforeMove` deducts 1 stam per
  // walking step and 2 per running step. Skip when GM/Admin (staff
  // walks free) so [go warps and admin patrols don't deplete stam.
  // When stam hits 0 we don't reject the move (UO doesn't either —
  // you can still creep at 0 stam), just stop draining.
  // `isStaff` already declared above for the cast-movement gate.
  if (!isStaff && (mob.stam ?? 0) > 0) {
    const cost = running ? 2 : 1;
    const before = mob.stam | 0;
    mob.stam = Math.max(0, before - cost);
    if (mob.stam !== before) {
      state.send(staminaUpdate({
        serial: mob.serial, current: mob.stam, max: mob.stamMax ?? 50,
      }));
    }
  }
  dispatchTileWalkEvents(state.ctx.world, mob, fromTile,
    { x: nx, y: ny, z: nz, map: mob.map });

  // Stealth — if the player is moving while hidden, consume one stealth
  // step. When the budget runs out, drop the hidden flag so nearby clients
  // see them again. Without this, hide+move was permanent invisibility.
  if (mob.hidden) {
    if ((mob.stealthSteps | 0) > 0) {
      mob.stealthSteps -= 1;
    } else {
      // Out of stealth budget — reveal. Inline the same broadcast the
      // _visibility.reveal() helper does (we can't reach that script-side
      // module from a server handler without a circular import).
      mob.hidden = false;
      mob.flags = (mob.flags | 0) & ~0x80;
      const incoming = mobileIncoming({
        serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
        direction: mob.direction, hue: mob.hue, flags: mob.flags,
        notoriety: mob.notoriety, equipment: [],
      });
      for (const other of nearbyClients(state.ctx.world, mob, mob)) {
        other.client.send(incoming);
      }
      state.sendSystemMessage?.('You are no longer hidden.');
    }
  }

  // Broadcast to nearby clients so they see this mobile move.
  const movingPkt = mobileMoving({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue, flags: mob.flags, notoriety: mob.notoriety,
  });
  for (const other of nearbyClients(state.ctx.world, mob, mob)) {
    other.client.send(movingPkt);
  }
}

const DIRECTION_DELTAS = [
  [ 0, -1], // 0 N
  [ 1, -1], // 1 NE
  [ 1,  0], // 2 E
  [ 1,  1], // 3 SE
  [ 0,  1], // 4 S
  [-1,  1], // 5 SW
  [-1,  0], // 6 W
  [-1, -1], // 7 NW
];

function handleUnicodeSpeech(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();     // opcode + length
  const type = r.readU8();
  const hue = r.readU16();
  const font = r.readU16();
  const lang = r.readAsciiFixed(4);
  // If type has high bit set, keywords follow (ignored for MVP).
  let text;
  // Bug-hunt #8 #7: ServUO + CUO cap player speech at 128 unicode chars.
  // The reader was unbounded — a 64 KB unicode burst gets re-broadcast
  // via the sector fan-out to every nearby player (Nx amplification).
  // Cap defensively here.
  const MAX_SPEECH_CHARS = 128;
  if ((type & 0xC0) !== 0) {
    text = r.readUnicodeNull(MAX_SPEECH_CHARS);
  } else {
    text = r.readUnicodeNull(MAX_SPEECH_CHARS);
  }
  processPlayerSpeech(state, { type, hue, font, lang, text });
}

function vendorSpeechIntent(text, vendor) {
  const lcText = String(text ?? '').trim().toLowerCase();
  if (!lcText) return null;
  const name = vendor?.name ? String(vendor.name).trim().toLowerCase() : '';
  return (
    lcText.includes('vendor buy') || lcText.includes('shop buy') ||
    lcText === 'buy' || lcText.endsWith(' buy') ||
    (name && lcText.includes(`${name} buy`))
  ) ? 'buy'
    : (
      lcText.includes('vendor sell') || lcText.includes('shop sell') ||
      lcText === 'sell' || lcText.endsWith(' sell') ||
      (name && lcText.includes(`${name} sell`))
    ) ? 'sell' : null;
}

function tryOpenVendorFromSpeech(state, speaker, text, hue = 0x03B2) {
  const world = state.ctx?.world;
  if (!world) return 0;
  let best = null;
  let bestIntent = null;
  let bestDist = Infinity;
  for (const mob of nearbyMobiles(world, speaker, speaker, 18)) {
    if (mob.client) continue;
    if (!vendors.get(mob.serial)) continue;
    const intent = vendorSpeechIntent(text, mob);
    if (!intent) continue;
    const dist = Math.max(Math.abs((mob.x | 0) - (speaker.x | 0)), Math.abs((mob.y | 0) - (speaker.y | 0)));
    if (dist < bestDist) {
      best = mob;
      bestIntent = intent;
      bestDist = dist;
    }
  }
  if (!best) return 0;
  const opened = bestIntent === 'buy'
    ? vendors.openBuy(state, best.serial)
    : vendors.openSell(state, best.serial);
  if (!opened) return 0;

  const line = bestIntent === 'buy'
    ? 'Pleasure doing business — what shall I sell you?'
    : 'Show me what you have for sale.';
  const pkt = unicodeMessage({
    serial: best.serial, graphic: best.body,
    type: 0, hue, name: best.name, text: line,
  });
  for (const viewer of nearbyClients(world, best, null, 18)) {
    viewer.client.send(pkt);
  }
  return best.serial >>> 0;
}

function processPlayerSpeech(state, { type = 0, hue = 0x03B2, font = 3, lang = 'ENU', text = '' } = {}) {
  void font; void lang;
  text = String(text ?? '').slice(0, 256);

  const mob = state.mobile;

  // Command prefix: `[cmd args` (GM) or `.cmd args` (user). Dispatch instead
  // of broadcasting as speech.
  trace('speech', `net#${state.id} text=${JSON.stringify(text)} type=0x${type.toString(16)}`);
  if (text && (text.startsWith('[') || text.startsWith('.'))) {
    const line = text.slice(1);
    trace('cmd', `net#${state.id} dispatch line=${JSON.stringify(line)} access=${state.account?.accessLevel}`);
    const handled = state.ctx.commands.dispatch(line, {
      sender: mob, state, world: state.ctx.world,
    });
    trace('cmd', `net#${state.id} dispatch handled=${handled}`);
    if (!handled) state.sendSystemMessage(`Unknown command: ${line.split(/\s+/)[0]}`);
    return;
  }

  // Channel chat: `/channelName message` — fanout to channel members
  // only, no overhead text. Mirrors ServUO's `Chat.cs` send path. The
  // `/help` shortcut joins+broadcasts to the Help channel; `/list`
  // dumps available channels; `/join name` / `/leave name` toggle.
  if (text && text.startsWith('/')) {
    const handled = handleChannelCommand(state, mob, text);
    if (handled) return;
  }

  // Quest-conversation advance — server parity #6. A player who started
  // a conversation by double-clicking an MLQuest NPC carries a session
  // ref in `state.questConvo[npc.serial]`; their next utterance routes
  // to `advanceConversation` so the dialogue tree can branch. We search
  // for the nearest such NPC that has an open session.
  try {
    const convo = state.ctx?.systems?.questConversation;
    if (convo?.advanceConversation && state.questConvo) {
      for (const npcSerialStr of Object.keys(state.questConvo)) {
        const npcSerial = parseInt(npcSerialStr, 10);
        const npc = state.ctx.world.mobiles.get(npcSerial);
        if (!npc || npc.map !== mob.map) continue;
        const d = Math.max(Math.abs(npc.x - mob.x), Math.abs(npc.y - mob.y));
        if (d > 4) continue;
        const payload = convo.advanceConversation({ playerState: state, npc, input: text });
        if (payload?.text) {
          state.sendSystemMessage?.(payload.text);
          break;
        }
      }
    }
  } catch (e) { console.error('[net] quest-conversation advance threw:', e); }

  // Pet keyword commands — UO classic "all follow", "all stay", "all
  // attack" etc. Routes to the same `[pet <cmd>` admin command so
  // there's a single code path. We still broadcast the speech so
  // bystanders see "<player> says: all follow".
  if (text && /^all\s+(follow|stay|guard|attack|release|come)\s*$/i.test(text)) {
    const sub = text.toLowerCase().split(/\s+/)[1];
    state.ctx.commands.dispatch?.(`pet ${sub}`, {
      sender: mob, state, world: state.ctx.world,
    });
  }

  const msg = unicodeMessage({
    serial: mob.serial, graphic: mob.body, type: type & 0x3F, hue, name: mob.name, text,
  });
  // Echo to self + anyone nearby.
  state.send(msg);
  for (const other of nearbyClients(state.ctx.world, mob, mob)) {
    other.client.send(msg);
  }
  try {
    state.ctx?.events?.emit?.('speech', { speaker: mob, state, text, hue, type });
  } catch (e) { console.error('[net] speech event threw:', e); }
  transmitCommunicationCrystals(state, mob, text);
  const handledVendorSerial = tryOpenVendorFromSpeech(state, mob, text, hue);

  // FAZA AG/AY/BH — push speech into nearby NPCs' `_heardSpeech` queue
  // so AI behaviours can react on their next tick.
  //
  // Three layers of filtering keep the broadcast cheap:
  //   1. `_listensToSpeech === true` — flag set by banker/trainer/etc
  //      to opt in. Without this, EVERY non-client mob (orcs, rats,
  //      dragons) accumulated chat with no consumer (FAZA AY #15).
  //   2. Optional keyword subscription — `_speechKeywords` array on
  //      the mob. When set, the speech is pushed only when the
  //      lower-cased text contains at least one entry (substring
  //      match). Behaviours that already do their own keyword scan
  //      can skip this by leaving the field undefined; FAZA BH wires
  //      banker/trainer/town-crier to declare their keywords so we
  //      stop pushing pure noise.
  //   3. Distance + map filter — same 18-tile bound as visibility.
  //
  // Drop OLDEST when overflowing (FAZA AT #10): AI consumes via
  // shift(), so keeping the latest 16 utterances mirrors the FIFO.
  const lcText = (text ?? '').toLowerCase();
  // Sector-aware fan-out — walks only mobile buckets in the 18-tile
  // earshot radius instead of all 11.7k mobiles. Speech is one of the
  // highest-frequency events (player chat + NPC barks); the old full
  // walk dominated handler-tick on populated shards. Bug-hunt #2 B7.
  const w = state.ctx.world;
  const sectors = w.sectors;
  if (sectors?.mobileSerialsNear) {
    for (const s of sectors.mobileSerialsNear(mob.map, mob.x, mob.y, 18)) {
      const other = w.mobiles.get(s);
      if (!other || other === mob || other.client) continue;
      if ((other.serial >>> 0) === handledVendorSerial) continue;
      if (!other._listensToSpeech) continue;
      if (other.map !== mob.map) continue;
      if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
      const keywords = other._speechKeywords;
      if (Array.isArray(keywords) && keywords.length > 0) {
        let hit = false;
        for (const k of keywords) {
          if (typeof k === 'string' && lcText.includes(k)) { hit = true; break; }
        }
        if (!hit) continue;
      }
      other._heardSpeech ??= [];
      other._heardSpeech.push({ speaker: mob, text, hue });
      while (other._heardSpeech.length > 16) other._heardSpeech.shift();
    }
    return;
  }
  for (const other of w.mobiles.values()) {
    if (other === mob || other.client) continue;
    if ((other.serial >>> 0) === handledVendorSerial) continue;
    if (!other._listensToSpeech) continue;
    if (other.map !== mob.map) continue;
    if (Math.abs(other.x - mob.x) > 18 || Math.abs(other.y - mob.y) > 18) continue;
    const keywords = other._speechKeywords;
    if (Array.isArray(keywords) && keywords.length > 0) {
      let hit = false;
      for (const k of keywords) {
        if (typeof k === 'string' && lcText.includes(k)) { hit = true; break; }
      }
      if (!hit) continue;
    }
    other._heardSpeech ??= [];
    other._heardSpeech.push({ speaker: mob, text, hue });
    while (other._heardSpeech.length > 16) other._heardSpeech.shift();
  }
}

function transmitCommunicationCrystals(state, speaker, text) {
  if (!speaker || !text || (text.startsWith('[') || text.startsWith('.') || text.startsWith('/'))) return;
  const world = state.ctx?.world;
  if (!world?.items) return;
  const candidates = [];
  const direct = world._childrenByParent?.get?.(speaker.serial);
  if (direct) {
    for (const serial of direct) {
      const it = world.items.get(serial);
      if (it?.crystalKind === 'broadcast') candidates.push(it);
    }
  }
  for (const it of nearbyItems(world, speaker, 2)) {
    if (it?.crystalKind === 'broadcast') candidates.push(it);
  }
  const seen = new Set();
  for (const crystal of candidates) {
    if (!crystal?.crystalActive || seen.has(crystal.serial)) continue;
    seen.add(crystal.serial);
    const receivers = Array.isArray(crystal.crystalReceivers) ? crystal.crystalReceivers : [];
    if (receivers.length === 0) continue;
    for (const serial of [...receivers]) {
      if ((crystal.crystalCharges | 0) <= 0) {
        crystal.crystalActive = false;
        crystal.itemId = 0x1ED0;
        break;
      }
      const receiver = world.items.get(serial >>> 0);
      if (!receiver) {
        crystal.crystalReceivers = receivers.filter((s) => (s >>> 0) !== (serial >>> 0));
        continue;
      }
      if (!receiver.crystalActive) continue;
      crystal.crystalCharges = Math.max(0, (crystal.crystalCharges | 0) - 1);
      const line = `Crystal: ${speaker.name ?? 'Someone'} says ${text}`;
      const root = rootMobileForItem(world, receiver);
      if (root?.client?.sendSystemMessage) {
        root.client.sendSystemMessage(line, 0x2B2);
        continue;
      }
      const pkt = unicodeMessage({
        serial: receiver.serial,
        graphic: receiver.itemId,
        type: 0,
        hue: 0x2B2,
        font: 3,
        name: 'Crystal',
        text: line,
      });
      for (const viewer of nearbyClients(world, receiver, null, 18)) viewer.client.send(pkt);
    }
  }
}

function rootMobileForItem(world, item) {
  let parent = item?.parent;
  for (let i = 0; i < 32 && parent != null; i++) {
    const mob = world.mobiles.get(parent >>> 0);
    if (mob) return mob;
    const container = world.items.get(parent >>> 0);
    if (!container) return null;
    parent = container.parent;
  }
  return null;
}

// ---- Pickup / Drop (0x07 / 0x08) -------------------------------------------
//
// Minimal ground-item pickup-and-drop. The held item lives on `state.heldItem`
// (hidden from the world; broadcast 0x1D to nearby clients when picked up and
// 0xF3 to nearby clients when dropped).

const PICKUP_RANGE = 3; // Chebyshev tile distance; ServUO uses 3 for ground.

function syncMobileEquipmentIndex(world, mob) {
  if (!world || !mob) return;
  const map = mob.equipment instanceof Map ? mob.equipment : new Map();
  map.clear();
  const arr = [];
  const idx = world._childrenByParent?.get?.(mob.serial);
  const iter = idx
    ? Array.from(idx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mob.serial);
  for (const it of iter) {
    const layer = it.layer | 0;
    if (layer <= 0) continue;
    map.set(layer, it);
    if (layer !== 21 && layer !== 0x1D) arr.push(it);
  }
  mob.equipment = map;
  mob._equipment = arr;
  const right = map.get(1);
  const left = map.get(2);
  const weapon = right?.weapon ? right : left?.weapon ? left : null;
  if (weapon) {
    mob._weapon = { ...weapon.weapon, slayer: weapon.slayer };
    mob._weaponSerial = weapon.serial;
  } else {
    mob._weapon = null;
    mob._weaponSerial = 0;
  }
  mob._hasShield = !!left?.shield;
  mob._dualWield = Boolean(right?.weapon && left?.weapon && !left?.shield);
  markAttrDirty(mob);
}

function removeEquippedIndexItem(mob, item) {
  if (!mob || !item) return;
  if (mob.equipment instanceof Map && item.layer) {
    const cur = mob.equipment.get(item.layer | 0);
    if (cur?.serial === item.serial) mob.equipment.delete(item.layer | 0);
  }
  if (Array.isArray(mob._equipment)) {
    mob._equipment = mob._equipment.filter((it) => it?.serial !== item.serial);
  }
  if ((mob._weaponSerial >>> 0) === (item.serial >>> 0)) {
    mob._weapon = null;
    mob._weaponSerial = 0;
  }
  markAttrDirty(mob);
}

function handlePickUp(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const amount = r.readU16();
  const requestedAmount = Math.max(1, amount | 0);

  const item = state.ctx.world.items.get(serial);
  if (!item || !(item.movable ?? true)) {
    state.send(bounce(0x00)); // CannotLift
    return;
  }
  // Pickup paths:
  //   - Ground (parent == null): map+range check.
  //   - Equipped on self (parent == self mob serial && layer > 0): always
  //     allowed — the client just dragged it off their own paperdoll. Without
  //     this branch the item fell into the "container that isn't open" check
  //     below and was rejected with bounce(0x02), which is what made
  //     unequipping silently fail ("nei da sie zdjac ubrania").
  //   - Container: must have that container open.
  const isWornBySelf = item.parent === state.mobile.serial && (item.layer ?? 0) > 0;
  // ANTI-DUPE: trade window items belong to ONE side only — the other
  // participant must not lift from the partner's offering. Without this
  // gate either side could pick up the partner's items the moment they
  // arrived (handleTradeDrop registers both sides' virtual containers
  // in both `openContainers` so the side-by-side view works). ServUO
  // enforces this in SecureTradeInfo.Lift — we mirror via session lookup.
  // Walk the parent chain ≤ 8 hops looking for a trade-container
  // ancestor. ServUO `SecureTrade.OnDragLift` mirrors loot-lock walk
  // semantics: any item NESTED in a bag-in-the-trade-window is
  // governed by the same ownership gate. Without this the partner
  // could lift items out of a chest-in-your-trade-window — pure
  // dupe/steal exploit.
  {
    let cur = item;
    for (let hop = 0; hop < 8 && cur; hop++) {
      const tradeOwner = tradeByContainer.get(cur.parent);
      if (tradeOwner) {
        const ownerSide = cur.parent === tradeOwner.containerA ? tradeOwner.a : tradeOwner.b;
        if (state !== ownerSide) {
          state.send(bounce(0x00));
          state.sendSystemMessage?.('You may not lift items from the partner\'s side of the trade.');
          return;
        }
        break;
      }
      cur = state.ctx?.world?.items?.get?.(cur.parent >>> 0) ?? null;
    }
  }
  // House lockdown ACL — owner / co-owner can move, anyone else gets
  // bounced. ServUO BaseHouse.IsLockedDown. We check the item AND
  // walk the parent chain (an item in a bag in a secure container
  // inherits the lockdown). Bug-hunt #2 A1+A2.
  if (item.movable !== false) {
    const houseReg = state.ctx?.houses ?? state.ctx?.systems?.houses;
    if (houseReg?.canMoveLockdown) {
      let lockedHouse = null;
      let cur = item;
      for (let hop = 0; hop < 8 && cur; hop++) {
        if (cur.x != null && cur.y != null && cur.map != null) {
          const h = houseReg.houseAt?.(cur.x, cur.y, cur.map);
          if (h && (h.lockdowns?.has?.(cur.serial >>> 0)
                 || h.secures?.has?.(cur.serial >>> 0))) {
            lockedHouse = h;
            break;
          }
        }
        if (cur.parent == null) break;
        cur = state.ctx.world.items.get(cur.parent);
      }
      if (lockedHouse) {
        // canMoveLockdown only matches the item's own serial; for
        // nested children we already found the locked root via the
        // walk above, so check the role directly.
        const role = houseReg.roleOf?.(lockedHouse, state.mobile.serial);
        if (role !== 'owner' && role !== 'coowner') {
          state.send(bounce(0x00));
          state.sendSystemMessage?.('That is locked down — only the house owner may move it.');
          return;
        }
      }
    }
  }
  if (item.parent == null) {
    if (item.map !== state.mobile.map) {
      state.send(bounce(0x02));
      return;
    }
    const dx = Math.abs(item.x - state.mobile.x);
    const dy = Math.abs(item.y - state.mobile.y);
    if (Math.max(dx, dy) > PICKUP_RANGE) {
      state.send(bounce(0x01));
      return;
    }
  } else if (isWornBySelf) {
    // Allowed.
  } else if (!state.openContainers.has(item.parent)) {
    // Same exception handleDrop uses: a container worn by the player counts
    // as implicitly open. Without this, picking an item out of the docked
    // pinned backpack window — which the user never explicitly double-clicks
    // open — bounced with 0x02 and the user couldn't move ANYTHING out of
    // their backpack until they manually used it.
    const parentItem = state.ctx.world.items.get(item.parent);
    const parentWornBySelf = !!parentItem
      && parentItem.parent === state.mobile.serial
      && (parentItem.layer ?? 0) > 0;
    if (!parentWornBySelf) {
      state.send(bounce(0x02));
      return;
    }
  }

  const wasInContainer = item.parent != null && !isWornBySelf;
  // Audit #35 P1 #2 — refuse lift FROM a locked container (walk the
  // parent chain ≤8 hops like the corpse loot-lock check). ServUO
  // `LockableContainer.OnDragLift`. Was missing — stale grid-loot
  // grabs and pre-opened chest gumps let thieves empty locked chests.
  if (wasInContainer) {
    let curLock = state.ctx.world.items.get(item.parent);
    for (let hop = 0; hop < 8 && curLock; hop++) {
      if (curLock.locked) {
        state.send(bounce(0x05));
        state.sendSystemMessage?.('That container is locked.');
        return;
      }
      if (curLock.parent == null) break;
      curLock = state.ctx.world.items.get(curLock.parent);
    }
  }
  // Corpse loot-lock: the top damager owns the corpse for the first 10s
  // (`corpse.lootLockUntil`). Outside that window, anyone may loot.
  // We test the IMMEDIATE parent only — items inside nested containers
  // dropped on a corpse inherit the corpse's lock through traversal,
  // which is what ServUO does too.
  if (wasInContainer) {
    // Bug-hunt #8 #4: walk the parent chain (≤8 hops) so a corpse's
    // loot-lock also gates items inside nested containers (a quest pouch
    // dropped on a fresh corpse). The old code only checked the immediate
    // parent — an outsider could lift anything nested before the 10s
    // window closed.
    const now = Date.now();
    let cur = state.ctx.world.items.get(item.parent);
    let lockOwner = 0;
    for (let hop = 0; hop < 8 && cur; hop++) {
      if (cur.lootLockUntil && now < cur.lootLockUntil) {
        lockOwner = cur.lootOwnerSerial >>> 0;
        break;
      }
      if (cur.parent == null) break;
      cur = state.ctx.world.items.get(cur.parent);
    }
    if (lockOwner && lockOwner !== state.mobile.serial) {
      const ownerMob = state.ctx.world.mobiles.get(lockOwner);
      const sameParty = ownerMob?._party && ownerMob._party === state.mobile._party;
      if (!sameParty) {
        state.send(bounce(0x00));
        state.sendSystemMessage?.('That belongs to someone else.');
        return;
      }
    }
  }
  const splitSourceParent = item.parent ?? null;
  const splitSourceWasGround = item.parent == null;
  const splitRemainder = (!isWornBySelf && requestedAmount < Math.max(1, item.amount | 0))
    ? splitStack(state.ctx.world, item, requestedAmount)
    : null;

  if (wasInContainer) {
    const session = tradeByContainer.get(item.parent);
    if (session) {
      const wasA = session.itemsA.has(item.serial);
      const wasB = session.itemsB.has(item.serial);
      session.itemsA.delete(item.serial);
      session.itemsB.delete(item.serial);
      if (splitRemainder) {
        if (wasA) session.itemsA.add(splitRemainder.serial);
        if (wasB) session.itemsB.add(splitRemainder.serial);
      }
      const removed = removeEntity(item.serial);
      session.a.send(removed);
      session.b.send(removed);
      if (splitRemainder) {
        const upd = containerContentUpdate({
          serial: splitRemainder.serial,
          itemId: splitRemainder.itemId,
          amount: splitRemainder.amount,
          gridX: splitRemainder.gridX ?? 0,
          gridY: splitRemainder.gridY ?? 0,
          gridLocation: splitRemainder.gridLocation ?? 0,
          hue: splitRemainder.hue ?? 0,
        }, splitSourceParent);
        session.a.send(upd);
        session.b.send(upd);
      }
      resetTradeAccept(session);
    }
    // Server parity #9 #8: track looters on corpses so Forensic Evaluation
    // (skill 38) can show the last person who took loot. Walk parent
    // chain — items nested inside a corpse count toward that corpse.
    {
      let p = state.ctx.world.items.get(item.parent);
      for (let hop = 0; hop < 8 && p; hop++) {
        if (p.kind === 'corpse') {
          if (!Array.isArray(p.lootedBy)) p.lootedBy = [];
          p.lootedBy.push(state.mobile?.name ?? `0x${state.mobile?.serial?.toString(16)}`);
          if (p.lootedBy.length > 5) p.lootedBy = p.lootedBy.slice(-5);
          break;
        }
        if (p.parent == null) break;
        p = state.ctx.world.items.get(p.parent);
      }
    }
  }
  if (isWornBySelf) {
    // FAZA BN: dispatch onUnequip BEFORE clearing the layer so the
    // script can still see what slot it left from.
    dispatchItemEvent(state.ctx.world, item, 'onUnequip', state.mobile);
    removeEquippedIndexItem(state.mobile, item);
    // Strip layer so it stops showing on the paperdoll/in-world overlay.
    item.layer = 0;
  }
  // setItemParent maintains the _childrenByParent reverse index — A5.
  setItemParent(state.ctx.world, item, state.mobile.serial);
  // Off the ground → off the sector index (parented items aren't tile-bound).
  state.ctx?.world?.sectors?.removeItem(item.serial);
  state.heldItem = item;
  // FAZA BN: lifecycle hook for ground / container pickup.
  dispatchItemEvent(state.ctx.world, item, 'onPickUp', state.mobile);
  // Wave 13: auto-identify magic items at high ItemIdentification skill.
  //   skill <70 → never auto (must run [identify)
  //   skill 70..89 → 50% chance per pickup
  //   skill 90..99 → 90% chance
  //   skill 100   → always
  // Mirrors ServUO's "passive ID" behaviour where high-skill characters
  // recognise magic at a glance. The pickup hook is the natural choke
  // point — players touch every drop they take.
  if (item._unidentified) {
    const skill = effectiveSkill(state.mobile, 4);
    let chance = 0;
    if (skill >= 100) chance = 1.00;
    else if (skill >= 90) chance = 0.90;
    else if (skill >= 70) chance = 0.50;
    if (chance > 0 && Math.random() < chance) {
      item._unidentified = false;
      state.sendSystemMessage?.(
        `${item.name ?? 'The item'} reveals its properties to your trained eye.`,
      );
      // Refresh tooltip so the player sees the new prop list immediately.
      const provider = state.ctx?.propertyProvider;
      if (provider && properties?.computeHash) {
        const r = provider(item.serial, state);
        if (r?.entries) properties.nudge(state, item.serial, properties.computeHash(r.entries));
      }
    }
  }
  const rm = removeEntity(item.serial);
  // Ground items and worn items both need to vanish from observers.
  if (!wasInContainer) {
    for (const other of nearbyClients(state.ctx.world, state.mobile, state.mobile)) {
      other.client.send(rm);
    }
  }
  state.send(rm);
  if (splitRemainder) {
    if (splitSourceParent != null) {
      const upd = containerContentUpdate({
        serial: splitRemainder.serial,
        itemId: splitRemainder.itemId,
        amount: splitRemainder.amount,
        gridX: splitRemainder.gridX ?? 0,
        gridY: splitRemainder.gridY ?? 0,
        gridLocation: splitRemainder.gridLocation ?? 0,
        hue: splitRemainder.hue ?? 0,
      }, splitSourceParent);
      state.send(upd);
      for (const m of state.ctx.world.mobiles.values()) {
        if (!m.client || m === state.mobile) continue;
        if (!m.client.openContainers?.has?.(splitSourceParent)) continue;
        m.client.send(rm);
        m.client.send(upd);
      }
    } else if (splitSourceWasGround) {
      const pkt2 = worldItemSA({
        serial: splitRemainder.serial,
        itemId: splitRemainder.itemId,
        amount: splitRemainder.amount,
        x: splitRemainder.x,
        y: splitRemainder.y,
        z: splitRemainder.z,
        hue: splitRemainder.hue,
        flags: (splitRemainder.movable ?? true) ? 0x20 : 0x00,
      });
      state.send(pkt2);
      for (const other of nearbyClients(state.ctx.world, state.mobile, state.mobile)) {
        other.client.send(pkt2);
      }
    }
  }
}

function handleDrop(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const x = r.readU16();
  const y = r.readU16();
  const z = r.readI8();
  let gridLocation = 0;
  if (r.remaining > 4) gridLocation = r.readU8();
  const container = r.readU32(); // 0xFFFFFFFF = ground, else container/mobile serial

  const item = state.heldItem;
  if (!item || item.serial !== serial) {
    state.send(dropAck(false));
    return;
  }

  if (container === 0xFFFFFFFF) {
    // Drop to ground. Reset ALL container-relative fields so a later
    // pickup → container move doesn't carry stale grid coords from the
    // ground state (gridLocation carries vendor-slot hints from the
    // buy window, for example, and will collide with other items).
    item.x = x;
    item.y = y;
    item.z = z;
    item.map = state.mobile.map;
    setItemParent(state.ctx.world, item, null);
    item.layer = 0;
    item.gridX = 0;
    item.gridY = 0;
    item.gridLocation = 0;
    state.ctx?.world?.sectors?.moveItem(item);
    state.heldItem = null;

    state.send(dropAck(true));
    const pkt2 = worldItemSA({
      serial: item.serial, itemId: item.itemId, amount: item.amount,
      x: item.x, y: item.y, z: item.z, hue: item.hue,
      flags: (item.movable ?? true) ? 0x20 : 0x00,
    });
    state.send(pkt2);
    for (const other of nearbyClients(state.ctx.world, state.mobile, state.mobile)) {
      other.client.send(pkt2);
    }
    // FAZA BN: ground-drop lifecycle hook.
    dispatchItemEvent(state.ctx.world, item, 'onDrop', null, state.mobile);
    return;
  }

  // Container drop. Must be an actual container the sender can see (either
  // currently open or the player's own held items).
  //
  // Trade containers are virtual (no entry in world.items) so handle them
  // before the normal container-lookup path.
  const tradeSession = tradeByContainer.get(container);
  if (tradeSession) {
    handleTradeDrop(state, item, tradeSession, container, x, y, gridLocation);
    return;
  }

  // Drop ON a mobile (target serial points at a mobile, not a container).
  // UO semantics — mirrors ServUO Mobile.OnDragDrop:
  //   - own mobile      → bounce (CUO blocks self-drops at the client too)
  //   - other player    → auto-open a trade session (or reuse the existing
  //                       one between these two) and stage the item on the
  //                       sender's side. ServUO does the same via
  //                       PlayerMobile.OnDragDrop → SecureTrade.
  //   - vendor / NPC    → no generic acceptor yet; refuse with a system
  //                       message so the item doesn't vanish into the NPC.
  //                       Content scripts can later override via a mobile
  //                       drag-drop hook.
  const targetMob = state.ctx.world.mobiles.get(container);
  if (targetMob) {
    const mdx = Math.abs(targetMob.x - state.mobile.x);
    const mdy = Math.abs(targetMob.y - state.mobile.y);
    const outOfRange = Math.max(mdx, mdy) > 2 || targetMob.map !== state.mobile.map;
    if (outOfRange || targetMob === state.mobile) {
      state.send(dropAck(false));
      state.send(bounce(0x01));
      bounceHeldToFeet(state, item);
      const bouncePkt = worldItemSA({
        serial: item.serial, itemId: item.itemId, amount: item.amount,
        x: item.x, y: item.y, z: item.z, hue: item.hue,
        flags: (item.movable ?? true) ? 0x20 : 0x00,
      });
      for (const other of nearbyClients(state.ctx.world, state.mobile, state.mobile)) {
        other.client.send(bouncePkt);
      }
      return;
    }
    // Player target: open or reuse a secure-trade session.
    if (targetMob.client) {
      const otherState = targetMob.client;
      let session = findTradeSession(state, otherState);
      if (!session) session = trade.open(state, otherState);
      if (!session) {
        state.send(dropAck(false));
        bounceHeldToFeet(state, item);
        return;
      }
      const ourContainer = session.a === state ? session.containerA : session.containerB;
      // Reuse the trade-drop path so accept flags reset, both sides see
      // the 0x25 update, and the item is tracked in itemsA/itemsB.
      handleTradeDrop(state, item, session, ourContainer, x, y, gridLocation);
      return;
    }
    // NPC target — give the registered drag-drop hook (if any) a chance
    // to accept the item. Hook semantics mirror ServUO `Mobile.OnDragDrop`:
    // returning truthy = item consumed (gold tip, quest turn-in, etc.);
    // returning falsy = refuse and bounce to dropper's feet.
    const hookHandled = mobileDragDrop.dispatch(state, targetMob, item);
    if (hookHandled) {
      // Hook took ownership. Item already removed/repurposed by the
      // script; just clear our held state and ack.
      state.heldItem = null;
      state.send(dropAck(true));
      return;
    }
    state.send(dropAck(false));
    bounceHeldToFeet(state, item);
    state.sendSystemMessage?.('They refuse the offering.');
    const refusePkt = worldItemSA({
      serial: item.serial, itemId: item.itemId, amount: item.amount,
      x: item.x, y: item.y, z: item.z, hue: item.hue,
      flags: (item.movable ?? true) ? 0x20 : 0x00,
    });
    for (const other of nearbyClients(state.ctx.world, state.mobile, state.mobile)) {
      other.client.send(refusePkt);
    }
    return;
  }
  const target = state.ctx.world.items.get(container);
  // The player's own equipped backpack (or any worn container) doesn't have
  // to have been double-clicked open before they can stuff items into it —
  // the paperdoll lets you drag straight onto the backpack icon. Treat any
  // container worn by `state.mobile` as implicitly open.
  const wornBySelf = !!target && target.parent === state.mobile.serial && (target.layer ?? 0) > 0;
  // Key dropped on a lockable container. ServUO `Key.cs::OnDragDrop`:
  // drop on unlocked -> bind (copy chest's KeyValue onto the key);
  // drop on locked -> if keys match unlock, else "this is not the
  // right key". Container has `keyValue` when
  // `template.kind === 'lockable-container'`.
  if (target?.lockable !== false && (target?.keyValue != null || item.key)) {
    if (item.key && target.keyValue != null) {
      if (target.locked) {
        if ((item.key.keyId | 0) === (target.keyValue | 0)) {
          target.locked = false;
          target.lockLevel = 0;
          state.send(dropAck(false));
          state.sendSystemMessage?.('You unlock it.');
          // Bounce the key back to caller so the cursor clears.
          setItemParent(state.ctx.world, item, state.mobile.serial);
          state.heldItem = null;
          return;
        }
        state.send(dropAck(false));
        state.sendSystemMessage?.('That is not the right key.');
        setItemParent(state.ctx.world, item, state.mobile.serial);
        state.heldItem = null;
        return;
      }
      // Unlocked container: blank key copies the chest's keyValue
      // (re-key); already-bound key with mismatched id locks the chest.
      if ((item.key.keyId | 0) === 0) {
        item.key.keyId = target.keyValue | 0;
        state.send(dropAck(false));
        state.sendSystemMessage?.('You bind the key to that container.');
        setItemParent(state.ctx.world, item, state.mobile.serial);
        state.heldItem = null;
        return;
      }
      if ((item.key.keyId | 0) === (target.keyValue | 0)) {
        target.locked = true;
        state.send(dropAck(false));
        state.sendSystemMessage?.('You lock it.');
        setItemParent(state.ctx.world, item, state.mobile.serial);
        state.heldItem = null;
        return;
      }
    }
  }
  // Audit #35 P1 #2 — refuse drop into a locked container. ServUO
  // `LockableContainer.OnDragDrop` gates on `Locked`. Was missing — a
  // thief who had the chest gump open from before the magic-lock or
  // stale grid-loot drag could keep stuffing items in.
  if (target?.locked) {
    state.send(dropAck(false));
    state.send(bounce(0x05));
    setItemParent(state.ctx.world, item, null);
    item.x = state.mobile.x; item.y = state.mobile.y; item.z = state.mobile.z;
    item.map = state.mobile.map;
    state.ctx?.world?.sectors?.moveItem(item);
    state.heldItem = null;
    state.sendSystemMessage?.('That container is locked.');
    return;
  }

  // ServUO parity: Item.OnDragDrop belongs to the target item.  Several
  // content scripts (runebook rune slots, key rings, trash barrels,
  // aquariums) are not plain containers; they need to inspect and often
  // consume the dropped item before the generic container path runs.
  if (target?.script) {
    const dropResult = dispatchItemEvent(state.ctx.world, target, 'onDrop', item, state.mobile);
    const handled = dropResult === true || dropResult?.handled === true;
    if (handled) {
      state.heldItem = null;
      const consumeHeld = dropResult === true || dropResult.consumeHeld !== false;
      state.send(dropAck(consumeHeld));
      if (consumeHeld && !state.ctx.world.items.has(item.serial)) {
        state.send(removeEntity(item.serial));
      }
      return;
    }
  }

  if (!target || !target.gumpId || (!state.openContainers.has(container) && !wornBySelf)) {
    state.send(dropAck(false));
    state.send(bounce(0x02));
    setItemParent(state.ctx.world, item, null);
    item.x = state.mobile.x; item.y = state.mobile.y; item.z = state.mobile.z;
    item.map = state.mobile.map;
    state.ctx?.world?.sectors?.moveItem(item);
    state.heldItem = null;
    const bouncePkt = worldItemSA({
      serial: item.serial, itemId: item.itemId, amount: item.amount,
      x: item.x, y: item.y, z: item.z, hue: item.hue,
      flags: (item.movable ?? true) ? 0x20 : 0x00,
    });
    state.send(bouncePkt);
    // Other observers also need to see the item appear at the dropper's
    // feet — without this, the item is "invisible" to nearby players until
    // they re-sync. Matches the successful ground-drop flow above.
    for (const other of nearbyClients(state.ctx.world, state.mobile, state.mobile)) {
      other.client.send(bouncePkt);
    }
    return;
  }

  // Bank box gate — ServUO caps a default player bank at 125 items +
  // 1600 stones total. If the target container chain ends at a bank
  // box (layer 0x1D worn by some player), enforce both caps before the
  // drop completes. Bypassed for non-bank containers (regular bags
  // chests, paperdoll bags) so this is zero-cost on the common path.
  if (target.layer === 0x1D || _isInsideBank(state.ctx.world, target)) {
    const bank = target.layer === 0x1D ? target : _findBankRoot(state.ctx.world, target);
    if (bank) {
      // Count current items + weight via the reverse parent index when
      // available — walks ~120 entries instead of all 110k world.items.
      // Falls back to the legacy walk for unit-test worlds that bypass
      // createItem. Bug-hunt 2026-05-12 A8.
      // Bug-hunt #9 #8: recurse into nested containers so a bag of 1500
      // stone gold doesn't pretend it's only 10 stones at the bank root.
      let count = 0, weight = 0;
      for (const it of itemsMod.containerChildrenRecursive(state.ctx.world, bank.serial)) {
        count++;
        weight += (it.weight ?? 0) * Math.max(1, it.amount ?? 1);
      }
      const incomingW = (() => {
        let w = (item.weight ?? 0) * Math.max(1, item.amount ?? 1);
        // If the incoming itself is a container, include its tree weight
        // so we can't dump a 1500-stone-bag past the 1600 ceiling.
        for (const it of itemsMod.containerChildrenRecursive(state.ctx.world, item.serial)) {
          w += (it.weight ?? 0) * Math.max(1, it.amount ?? 1);
        }
        return w;
      })();
      const BANK_MAX_ITEMS = 125;
      const BANK_MAX_WEIGHT = 1600;
      if (count >= BANK_MAX_ITEMS || (weight + incomingW) > BANK_MAX_WEIGHT) {
        state.send(dropAck(false));
        state.send(bounce(0x05));
        bounceHeldToFeet(state, item);
        state.sendSystemMessage?.(count >= BANK_MAX_ITEMS
          ? 'Your bank box is full (125 items max).'
          : `Your bank box can't hold any more weight (${BANK_MAX_WEIGHT} stones max).`);
        return;
      }
    }
  }

  // Bug-hunt #8 #5: enforce per-container capacity / max-weight when the
  // template provides those fields (carpentry chests, pouches, trash bag
  // etc. set them via content/items/containers.js). Without this a tiny
  // 25-stone pouch could hold 4000 gold piles. Bank already covers its
  // own cap above; we only run the generic check when target.capacity
  // or target.maxWeight is set AND it's not the bank.
  if (target.layer !== 0x1D
      && (Number.isFinite(target.capacity) || Number.isFinite(target.maxWeight))) {
    let count = 0, weight = 0;
    const idx = state.ctx.world._childrenByParent;
    const set = idx?.get?.(target.serial);
    if (set) {
      for (const s of set) {
        const it = state.ctx.world.items.get(s);
        if (!it) continue;
        count++;
        weight += (it.weight ?? 0) * Math.max(1, it.amount ?? 1);
      }
    } else {
      for (const it of state.ctx.world.items.values()) {
        if (it.parent !== target.serial) continue;
        count++;
        weight += (it.weight ?? 0) * Math.max(1, it.amount ?? 1);
      }
    }
    const incomingW = (item.weight ?? 0) * Math.max(1, item.amount ?? 1);
    const cap   = Number.isFinite(target.capacity)  ? target.capacity  : Infinity;
    const wcap  = Number.isFinite(target.maxWeight) ? target.maxWeight : Infinity;
    if (count >= cap || (weight + incomingW) > wcap) {
      state.send(dropAck(false));
      state.send(bounce(0x05));
      bounceHeldToFeet(state, item);
      state.sendSystemMessage?.(count >= cap
        ? `That container is full (${cap} items max).`
        : `That container can't hold any more weight (${wcap} stones max).`);
      return;
    }
  }

  // BUGFIX #62 (FAZA CT): auto-stack stackable items into an existing
  // pile in the same container. The previous handler always created a
  // separate slot — players ended up with twelve gold piles in their
  // pack, twelve "Iron Ingot 1" entries from a single buy session, etc.
  // Mirrors ServUO's `BaseContainer.OnDragDrop → Item.StackWith`.
  // Returns: when a merge happens we ship a removeEntity for the
  // incoming item AND a containerContentUpdate for the now-bigger pile,
  // to every client with the container open.
  const mergeTarget = findMergeableStack(state.ctx.world, container, item);
  if (mergeTarget) {
    const incomingSerial = item.serial;
    mergeStacks(state.ctx.world, mergeTarget, item);
    state.heldItem = null;
    state.send(dropAck(true));
    const remove = removeEntity(incomingSerial);
    const upd = containerContentUpdate({
      serial: mergeTarget.serial, itemId: mergeTarget.itemId,
      amount: mergeTarget.amount,
      gridX: mergeTarget.gridX ?? 0,
      gridY: mergeTarget.gridY ?? 0,
      gridLocation: mergeTarget.gridLocation ?? 0,
      hue: mergeTarget.hue ?? 0,
    }, container);
    state.send(remove);
    state.send(upd);
    for (const m of state.ctx.world.mobiles.values()) {
      if (!m.client || m === state.mobile) continue;
      if (m.client.openContainers?.has?.(container)) {
        m.client.send(remove);
        m.client.send(upd);
      }
    }
    return;
  }

  // Bug-hunt #8 #6 — refuse a drop that would create a parent cycle
  // (bag onto itself / bag onto a child of itself). Without this check
  // the item becomes unreachable from any container query and persists
  // as an orphan after the next save; partitionWorld walks it into the
  // wrong bucket on reload.
  if (container === item.serial) {
    state.send(dropAck(false));
    state.send(bounce(0x02));
    bounceHeldToFeet(state, item);
    return;
  }
  {
    let cur = state.ctx.world.items.get(container);
    let cyclic = false;
    for (let hop = 0; hop < 8 && cur; hop++) {
      if (cur.serial === item.serial) { cyclic = true; break; }
      if (cur.parent == null) break;
      cur = state.ctx.world.items.get(cur.parent);
    }
    if (cyclic) {
      state.send(dropAck(false));
      state.send(bounce(0x02));
      bounceHeldToFeet(state, item);
      state.sendSystemMessage?.('You cannot put a container inside itself.');
      return;
    }
  }

  setItemParent(state.ctx.world, item, container);    // A5
  item.layer = 0;
  item.gridX = x & 0xffff;
  item.gridY = y & 0xffff;
  item.gridLocation = gridLocation;
  item.map = 0;
  state.heldItem = null;
  state.send(dropAck(true));
  const updPkt = containerContentUpdate({
    serial: item.serial, itemId: item.itemId, amount: item.amount,
    gridX: item.gridX, gridY: item.gridY, gridLocation: item.gridLocation,
    hue: item.hue,
  }, container);
  state.send(updPkt);
  // Other players who have this same container open (corpse loot, shared
  // chest, traded backpack) also need to see the new item — without this,
  // their UI shows stale contents until they re-open the container.
  for (const m of state.ctx.world.mobiles.values()) {
    if (!m.client || m === state.mobile) continue;
    if (m.client.openContainers?.has?.(container)) m.client.send(updPkt);
  }
}

// ---- Use / Double-click (0x06) --------------------------------------------
//
// Minimal container-open support. For an item with `gumpId` set we send the
// 0x24 DisplayContainer + 0x3C ContainerContents pair and record the serial
// on the client so subsequent pickups/drops can be authorized.

function handleUseReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) {
    trace('use', `net#${state.id}: rejected — stage=${state.stage} mobile=${!!state.mobile}`);
    return;
  }
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  trace('use', `net#${state.id} target=0x${serial.toString(16)}`);

  // Double-click on a mobile.
  //   - vendor       → open buy window (canonical UO interaction)
  //   - self         → open own paperdoll, with "can lift" flag set
  //   - other mobile → open THEIR paperdoll (read-only; no equipping
  //                    on someone else's body — the client paperdoll
  //                    distinguishes self vs. other via the flags byte)
  const mob = state.ctx.world.mobiles.get(serial);
  if (mob) {
    if (vendorRegistry.has(mob.serial)) {
      // Shopkeeper — open their buy window first; double-clicking a
      // vendor in canon UO is the "buy" gesture, not a paperdoll open.
      vendors.openBuy(state, mob.serial);
      return;
    }
    // FAZA CK — every mobile gets a paperdoll. Self → can-lift bit;
    // other mobiles (NPCs, players, mounted creatures) → no can-lift,
    // so the client renders a read-only doll the user can move and
    // close but not equip / unequip.
    const isSelf = mob === state.mobile;
    state.send(openPaperdoll({
      serial: mob.serial,
      title: mob.title ? `${mob.name}, ${mob.title}` : (mob.name ?? ''),
      flags: isSelf ? 0x02 : 0x00,
    }));
    return;
  }

  const item = state.ctx.world.items.get(serial);
  if (!item) return;
  if (bookRegistry.has(item.serial)) {
    books.open(state, item.serial);
    return;
  }
  // Auto-register spellbook items by their canonical graphic id when
  // the item template path didn't fire `onCreate` (items.json data-driven
  // spawns and equip-from-pack flows skip the lifecycle hook). Mirrors
  // CUO `Spellbook.OnDoubleClick` — it dispatches by class, we dispatch
  // by graphic. Each graphic maps to the school's first-spell offset
  // (Magery=1, Necro=101, Chiv=201, Bushido=401, Ninjitsu=501,
  // Spellweaving=601, Mysticism=678).
  ensureSpellbookRegisteredFromItem(item);
  if (spellbookRegistry.has(item.serial)) {
    // BUGFIX #137 (FAZA JF): the previous code sent BOTH 0xBF 0x1B
    // (NewSpellbookContent) AND 0x24 DisplayContainer, so the client
    // opened the parchment spellbook gump AND a container window for
    // the same serial — Marcin's screenshot showed the bag gump
    // surfacing instead of the spellbook because the container
    // window stacked on top. ServUO `Spellbook.cs::OnDoubleClick`
    // sends ONLY the spellbook content packet; the client opens the
    // gump from that. Do the same.
    spellbooks.sendContent(state, item.serial);
    return;
  }
  // Container items still need their lifecycle script before the generic
  // gump-open path. Treasure chests, quest reward bags and trapped
  // containers are containers visually, but behaviorally they may need to
  // reject/open/seed contents first.
  if (item.gumpId && dispatchItemEvent(state.ctx.world, item, 'onUse', state.mobile)) {
    return;
  }
  if (!item.gumpId) {
    // Not a container — dispatch to template onUse if any, else no-op reply.
    const used = useTemplateItem(state.ctx.world, item, state.mobile);
    if (!used) state.sendSystemMessage(`You see nothing special about that.`);
    return;
  }

  // BUGFIX #129 (FAZA HO): the open-container path opened locked
  // chests anyway — the `locked` flag was set by Magic Lock /
  // treasure spawns but nothing in the dispatch read it. Players
  // popped open every chest they double-clicked. Refuse the open
  // and message the player; lockpick / Unlock is the supported
  // counter-path.
  if (item.locked) {
    state.sendSystemMessage('It is locked.');
    return;
  }

  if (springContainerTrap(state, item)) return;

  // House secure / lockdown ACL on open — bug-hunt #4 A4. Without
  // this, a random visitor could double-click a secured chest in the
  // owner's house and see contents. ServUO `SecureContainer.OnUse`.
  // Walk parent chain (or check the container itself) for membership
  // in any house's lockdowns/secures set; reject non-friend/coowner.
  const houseReg = state.ctx?.houses ?? state.ctx?.systems?.houses;
  if (houseReg?.houseAt) {
    let cur = item;
    let lockedHouse = null;
    for (let hop = 0; hop < 8 && cur; hop++) {
      if (cur.x != null && cur.y != null && cur.map != null) {
        const h = houseReg.houseAt(cur.x, cur.y, cur.map);
        if (h && (h.lockdowns?.has?.(cur.serial >>> 0)
               || h.secures?.has?.(cur.serial >>> 0))) {
          lockedHouse = h;
          break;
        }
      }
      if (cur.parent == null) break;
      cur = state.ctx.world.items.get(cur.parent);
    }
    if (lockedHouse) {
      const role = houseReg.roleOf?.(lockedHouse, state.mobile.serial);
      if (role !== 'owner' && role !== 'coowner' && role !== 'friend') {
        state.sendSystemMessage('That belongs to the house owner.');
        return;
      }
    }
  }

  openContainerFor(state, item);
}

/**
 * @param {import('./net-state.js').NetState} state
 * @param {import('../world/items.js').Item} container
 */
// CUO/UO container open sound table — `ContainerData.OpenSound` per
// gumpId. Without this the bag opens silently. We ship a tight subset
// matching the most common bags + chests; everything else falls back
// to 0x48 (generic bag rustle). Mirrors `ContainerManager.txt` open IDs.
const CONTAINER_OPEN_SOUND = {
  0x003C: 0x48,  // Backpack (rustle)
  0x003D: 0x48,  // Bank box
  0x003E: 0x48,  // Pouch
  0x003F: 0x48,  // Pouch
  0x0040: 0x4F,  // Wood box (creak)
  0x0041: 0x4F,  // Wood box
  0x0042: 0x4F,  // Crate
  0x0043: 0x4F,  // Crate
  0x0044: 0x4F,  // Crate
  0x0045: 0x4F,  // Picnic basket
  0x0048: 0x4F,  // Fancy chest
  0x0049: 0x4F,  // Crystal chest
  0x004A: 0x4F,  // Heart chest
  0x004B: 0x4F,  // Drawer
  0x004C: 0x4F,  // Bookcase
  0x051A: 0x4F,  // Drawer
  0x09B7: 0x4F,  // Heart-shaped chest
  0x2006: 0x48,  // Corpse (rustle)
};

function readContainerTrap(item) {
  if (!item) return null;
  if ((item._magicTrapDmg | 0) > 0) {
    return {
      damage: Math.max(1, item._magicTrapDmg | 0),
      sourceSerial: item._magicTrapBy >>> 0,
      magic: true,
    };
  }
  const trapped = item.trapped;
  if (!trapped) return null;
  if (typeof trapped === 'object') {
    const base = Math.max(1, trapped.damage | 0);
    const level = Math.max(1, trapped.level | 0);
    return {
      damage: Math.max(1, base * level),
      sourceSerial: trapped.by >>> 0,
      magic: trapped.kind === 'magic',
    };
  }
  const power = Math.max(1, item.trapPower | 0);
  return { damage: 10 + Math.floor(power / 10), sourceSerial: 0, magic: false };
}

function clearContainerTrap(item, trap) {
  if (!item || !trap) return;
  if (trap.magic || (item._magicTrapDmg | 0) > 0) {
    item._magicTrapDmg = 0;
    item._magicTrapBy = 0;
  }
  if (item.trapped) delete item.trapped;
  if ((item.trapPower | 0) > 0) item.trapPower = 0;
}

function springContainerTrap(state, item) {
  const trap = readContainerTrap(item);
  if (!trap || !state?.mobile) return false;

  const world = state.ctx?.world;
  const victim = state.mobile;
  const source = trap.sourceSerial ? world?.mobiles?.get?.(trap.sourceSerial) : null;
  const amount = Math.max(1, trap.damage | 0);
  clearContainerTrap(item, trap);

  state.sendSystemMessage?.(trap.magic
    ? 'The magical trap explodes!'
    : 'A trap detonates!');

  const combat = state.ctx?.handlers?.combat ?? world?._combat;
  if (combat?.damage) {
    try {
      combat.damage(world, victim, amount, source ?? null, {
        damageType: trap.magic ? { energy: 100 } : { fire: 100 },
      });
      return true;
    } catch {
      // Fall through to the local packet path below.
    }
  }

  victim.hp = Math.max(0, (victim.hp ?? victim.hpMax ?? 50) - amount);
  const hp = healthUpdate({
    serial: victim.serial,
    current: victim.hp,
    max: victim.hpMax ?? 50,
  });
  const dmg = damagePacket({ serial: victim.serial, amount });
  state.send(hp);
  state.send(dmg);
  for (const other of nearbyClients(world, victim, victim)) {
    if (other === victim) continue;
    other.client?.send?.(hp);
    other.client?.send?.(dmg);
  }
  return true;
}

function openContainerFor(state, container) {
  // Back-fill the canonical bank-box gump for legacy save files. Every
  // pre-migration bank was created with gumpId=0x003C (the default
  // backpack art) — fix one-time on open so the operator doesn't have
  // to wipe saves to get the correct chest art. Layer 0x1D = Bank,
  // which mob.equipment indexes when the character is created. Same
  // pattern we use for "container.gumpId missing" defaults elsewhere.
  if ((container.layer | 0) === 0x1D && (container.gumpId | 0) === 0x003C) {
    container.gumpId = 0x004A;
  }
  // Play the open sound first so the audible cue precedes the gump
  // popping up — matches CUO `Item.OnDoubleClick` ordering.
  const snd = CONTAINER_OPEN_SOUND[container.gumpId] ?? 0x48;
  if (snd) {
    state.send(playSound({
      soundId: snd, x: container.x ?? 0, y: container.y ?? 0, z: container.z ?? 0,
    }));
  }
  state.send(displayContainer(container.serial, container.gumpId));
  const entries = [];
  for (const child of containerChildren(state.ctx.world, container.serial)) {
    entries.push({
      serial: child.serial,
      itemId: child.itemId,
      amount: child.amount,
      gridX: child.gridX ?? 0,
      gridY: child.gridY ?? 0,
      gridLocation: child.gridLocation ?? 0,
      hue: child.hue ?? 0,
    });
  }
  state.send(containerContents(container.serial, entries));
  state.openContainers.add(container.serial);
}

// ---- Status request (0x34) -----------------------------------------------
//
// The classic client sends 0x34 when the player double-clicks their own
// paperdoll's status button. We respond with 0x11 MobileStatus.

function handleStatusReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const r = new PacketReader(pkt);
  r.readU8();
  r.readU32(); // 0xEDEDEDED edit flag
  const kind = r.readU8(); // 4 = status, 5 = skills
  const serial = r.readU32();
  const mob = state.ctx.world.mobiles.get(serial);
  if (!mob) return;

  if (kind === 5) {
    // Skills request — send ALL 58 ServUO skills so the gump shows
    // the full catalogue with untrained ones at 0.0. Iterating only
    // mob.skills entries (the 1-4 the creator picked) hid every
    // unpicked skill. Mirrors CUO `Mobile.OnSnoop`.
    //
    // CRITICAL: type byte. UO 0x3A type semantics:
    //   0x00 = full snapshot, no caps (legacy pre-AOS)
    //   0x02 = full snapshot, with caps (post-AOS)
    //   0xDF = single skill, with caps  (NOT a snapshot — terminator-bearing)
    //   0xFF = single skill, no caps    (single-skill update only)
    // Sending 0xDF for the full list made the client break after the
    // first entry (decodeSkills sees `isSingle=true` and `break`s).
    // 0x02 = ServUO `Mobile.SendSkillsFull` canonical type.
    const skills = [];
    // ServUO sends skill IDs 1-indexed on the wire (Alchemy=1). The
    // client then `id - 1` to map back to the SKILL_NAMES array. Earlier
    // we wrote raw `id` (0..57) and the client interpreted `id - 1` as
    // -1 → skill misalignment + Alchemy missing from the gump.
    for (let id = 1; id <= 58; id++) {
      const v = skillValueRaw(mob, id);
      skills.push({
        id,
        value: v,
        base: v,
        lock: skillLockFor(mob, id),
        cap: skillCapRaw(mob, id),
      });
    }
    state.send(sendSkills({ skills, type: 0x02 }));
    return;
  }

  // BUGFIX #54 (FAZA CL): non-self status requests get the "brief"
  // version (name + HP/hpMax only). Sending the full extended payload
  // for any mobile leaked stats / gold / stam / mana to anyone who
  // dragged out a status bar. ServUO does the same gate.
  //
  // Tie isSelf to the REQUESTED serial, not the resolved mob object.
  // Player-mob binding can diverge across save/load (legacy slot
  // collision recovery) — the resolved `mob` object may not be
  // referentially === state.mobile even though both share the same
  // serial. The serial comparison is what UO actually keys on.
  const isSelf = serial === (state.mobile?.serial >>> 0);
  // Always echo the three attribute packets so HP/MP/ST bars fill
  // even when the v5 mobileStatus payload runs into a length mismatch
  // and the client decoder bails before reaching the v01 block.
  if (isSelf) {
    state.send(healthUpdate({ serial: mob.serial,
      current: mob.hp ?? 50, max: mob.hpMax ?? 50 }));
    state.send(manaUpdate({ serial: mob.serial,
      current: mob.mana ?? 50, max: mob.manaMax ?? 50 }));
    state.send(staminaUpdate({ serial: mob.serial,
      current: mob.stam ?? 50, max: mob.stamMax ?? 50 }));
  }
  state.send(mobileStatus({
    serial: mob.serial, name: mob.name,
    hp: mob.hp ?? 50, hpMax: mob.hpMax ?? 50,
    canRename: isSelf,
    // v5 default for self — sends resists / luck / damage / tithing.
    // v0 for non-self keeps the leak-protection from BUGFIX #54.
    version: isSelf ? 0x05 : 0x00,
    // Extended fields only matter when version >= 0x03; harmless to
    // pass for self.
    mana: mob.mana ?? 50, manaMax: mob.manaMax ?? 50,
    stam: mob.stam ?? 50, stamMax: mob.stamMax ?? 50,
    str: mob.str ?? 50, dex: mob.dex ?? 50, int: mob.int ?? 50,
    gold: mob.gold ?? 0, sex: mob.sex ?? 0,
    ar: mob.ar ?? 0,
    // Live-compute carrying weight: backpack + every worn equipment
    // layer summed via tiledata stones. ServUO `Mobile.TotalWeight`
    // ticks the same calc on every container change; doing it on
    // the status request is cheap enough (a few dozen items per
    // player) and keeps the gump in sync without wiring a per-drop
    // status broadcast.
    weight: (function calcWeight() {
      try {
        const w = state.ctx?.world;
        if (!w) return mob.weight | 0;
        // The player's worn backpack carries the bulk of the load.
        let total = wornWeight(w, mob.serial);
        for (const eq of w.items.values()) {
          if (eq.parent === mob.serial && eq.layer === 21 && eq.gumpId) {
            total += totalWeight(w, eq.serial);
            break;
          }
        }
        return total;
      } catch { return mob.weight | 0; }
    })(),
    weightMax: mob.weightMax ?? ((mob.str ?? 50) * 4 + 25),
    race: racePacketId(mob.race, mob.body),
    statCap: mob.statCap ?? 225,
    followers: mob.followers ?? 0,
    followersMax: mob.followersMax ?? 5,
    // v5 fields (resists + luck + damage + tithing). Default zeros so
    // a non-AOS mob simply shows "0" rather than missing rows.
    fireResist:   mob.fireResist   ?? 0,
    coldResist:   mob.coldResist   ?? 0,
    poisonResist: mob.poisonResist ?? 0,
    energyResist: mob.energyResist ?? 0,
    luck:         mob.luck         ?? 0,
    dmgMin:       mob.dmgMin       ?? 0,
    dmgMax:       mob.dmgMax       ?? 0,
    tithingPoints:mob.tithingPoints ?? 0,
  }));
}

// ---- Target cursor (0x6C response) ---------------------------------------
//
// Target requests are sent by scripts via `state.requestTarget(cb)`, which
// allocates a correlation id and stores the callback. When the client replies
// we look up the callback, resolve it with the picked target, and clear the
// slot. IDs are scoped per-NetState; stale responses are silently dropped.

function handleTargetResponse(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  let parsed;
  try { parsed = readTargetResponse(pkt); }
  catch { return; }
  const cb = state.targetCallbacks?.get(parsed.id);
  if (!cb) return;
  state.targetCallbacks.delete(parsed.id);
  try {
    // If the client cancelled (flags=3 or null everything), pass `null`.
    const cancelled = parsed.flags === 3 || (parsed.serial === 0 && parsed.x === 0 && parsed.y === 0 && parsed.graphic === 0);
    cb(cancelled ? null : parsed);
  } catch (e) {
    console.error('[target] callback threw:', e);
  }
}

/**
 * Build a helper the ScriptAPI can expose to solicit a target.
 * Attaches `requestTarget(state, cb, opts?)` behavior here (kept in handlers
 * module so it stays near the 0x6C wire code).
 *
 * Exposed via `api.targeting.request(state, cb, opts?)`.
 */
export const targeting = {
  /**
   * @param {import('./net-state.js').NetState} state
   * @param {(picked: {kind:number,id:number,flags:number,serial:number,x:number,y:number,z:number,graphic:number} | null) => void} cb
   * @param {{kind?:number, flags?:number}} [opts]
   */
  request(state, cb, opts = {}) {
    // 0xBF 0x2D TargetedSpell macro: client armed a target serial on
    // the caster before the spell call. Fulfil the request immediately
    // from that stash so the cursor never opens.
    const pre = state.mobile?._pendingMacroTargetSerial;
    if (pre) {
      delete state.mobile._pendingMacroTargetSerial;
      const world = state.ctx?.world;
      const m = world?.mobiles?.get(pre);
      const it = m ? null : world?.items?.get(pre);
      if (m) {
        cb({ kind: 1, id: 0, flags: opts.flags ?? 0, serial: pre,
             x: m.x | 0, y: m.y | 0, z: m.z | 0, graphic: m.body | 0 });
        return;
      }
      if (it) {
        cb({ kind: 0, id: 0, flags: opts.flags ?? 0, serial: pre,
             x: it.x | 0, y: it.y | 0, z: it.z | 0, graphic: it.itemId | 0 });
        return;
      }
      // Stale serial — fall through to cursor.
    }
    if (!state.targetCallbacks) state.targetCallbacks = new Map();
    const id = (state._nextTargetId = (state._nextTargetId ?? 1) + 1);
    state.targetCallbacks.set(id, cb);
    state.send(targetRequest({ id, kind: opts.kind ?? 0, flags: opts.flags ?? 0 }));
  },
};

// ---------------------------------------------------------------------------
// Gump dispatch.
// ---------------------------------------------------------------------------

function handleGumpResponse(state, pkt) {
  let parsed;
  try { parsed = readGumpResponse(pkt); }
  catch { return; }
  // Audit rev.9 — Virtue gump 0x1CD bypasses the activeGumps table
  // because the client opens it locally (no server-pushed layout).
  // We invoke the matching virtue server-side via `invokeVirtue`.
  if ((parsed.gumpId >>> 0) === 0x1CD) {
    try {
      const mob = state.mobile;
      if (!mob) return;
      const VIRTUE_KEY = ['', 'honesty', 'compassion', 'valor', 'justice',
                          'sacrifice', 'honor', 'spirituality', 'humility'];
      const key = VIRTUE_KEY[(parsed.buttonId | 0)];
      if (!key) return;
      Promise.resolve().then(async () => {
        try {
          const { invokeVirtue } = await import('../systems/rewards/virtues.js');
          const result = invokeVirtue(mob, key, /* target */ null);
          if (!result?.ok) {
            state.sendSystemMessage?.(`Cannot invoke ${key}: ${result?.reason ?? 'unknown'}.`);
          } else {
            state.sendSystemMessage?.(`You invoke ${key.charAt(0).toUpperCase() + key.slice(1)}.`);
          }
        } catch (e) { console.warn('[virtue] invoke failed:', e?.message); }
      });
    } catch { /* ignore */ }
    return;
  }
  const cb = state.activeGumps?.get(parsed.gumpId);
  if (!cb) return;
  state.activeGumps.delete(parsed.gumpId);
  try { cb(parsed); }
  catch (e) { console.error('[gump] callback threw:', e); }
}

/**
 * @typedef {(resp: {serial:number, gumpId:number, buttonId:number, switches:number[], textEntries:{entryId:number,text:string}[]}) => void} GumpCallback
 */
export const gumps = {
  /**
   * Send a gump to the client. Returns the chosen gumpId.
   *
   * @param {import('./net-state.js').NetState} state
   * @param {{layout:string, texts?:string[], x?:number, y?:number, gumpId?:number}} gump
   * @param {GumpCallback} [cb]
   */
  send(state, gump, cb) {
    if (!state.activeGumps) state.activeGumps = new Map();
    const gumpId = gump.gumpId ?? (state._nextGumpId = (state._nextGumpId ?? 1) + 1);
    if (cb) state.activeGumps.set(gumpId, cb);
    const layout = gump.layout;
    const texts = gump.texts ?? [];
    const builder = layout.length > PACKED_GUMP_THRESHOLD ? displayGumpPacked : displayGump;
    state.send(builder({
      serial: state.mobile?.serial ?? 0,
      gumpId,
      x: gump.x ?? 100,
      y: gump.y ?? 100,
      layout,
      texts,
    }));
    return gumpId;
  },
  close(state, gumpId) {
    if (state.activeGumps?.has(gumpId)) state.activeGumps.delete(gumpId);
  },
};

function handleWearItem(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  let parsed;
  try { parsed = readWearItem(pkt); }
  catch { return; }
  const world = state.ctx.world;
  const item = world.items.get(parsed.itemSerial);
  const mob = world.mobiles.get(parsed.mobileSerial);
  if (!item || !mob) { state.send(bounce(0)); return; }
  // Only the holder (state.heldItem) can equip. Reject otherwise.
  // state.heldItem is an Item *object*, not a serial — compare via .serial.
  if (!state.heldItem || state.heldItem.serial !== item.serial) {
    state.send(bounce(5));
    return;
  }
  // Audit #35 P2 #8 — ServUO `BaseArmor.CanEquip` refuses when `from.Str
  // < StrRequirement` (cliloc 500213 "You are not strong enough to use
  // this."). The armor templates ship with `strReq` fields (e.g.
  // plate=95) but no equip-time check enforced them.
  if (Number.isFinite(item.strReq) && (mob.str | 0) < (item.strReq | 0)) {
    state.send(bounce(5));
    state.sendSystemMessage?.('You are not strong enough to use this.');
    return;
  }
  if (Number.isFinite(item.dexReq) && (mob.dex | 0) < (item.dexReq | 0)) {
    state.send(bounce(5));
    state.sendSystemMessage?.('You are not dexterous enough to use this.');
    return;
  }
  if (Number.isFinite(item.intReq) && (mob.int | 0) < (item.intReq | 0)) {
    state.send(bounce(5));
    state.sendSystemMessage?.('You are not intelligent enough to use this.');
    return;
  }
  if ((mob._resetEquipUntil ?? 0) > Date.now()) {
    state.send(bounce(5));
    state.sendSystemMessage?.('You must wait a moment before equipping another weapon.');
    return;
  }
  // Consolidated layer-collision + hand-mutex scan. Bug-hunt #2 B5:
  // previously two/three separate full mobiles+items walks; now ONE
  // walk over worn slots via the reverse parent index.
  const targetLayer = parsed.layer;
  const otherLayer = targetLayer === 1 ? 2 : targetLayer === 2 ? 1 : 0;
  const wantPop = (otherLayer && item.weapon);
  const popQueue = [];
  const wornIdx = world._childrenByParent?.get?.(mob.serial);
  const wornIter = wornIdx
    ? Array.from(wornIdx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mob.serial);
  for (const it of wornIter) {
    if (it === item) continue;
    // Layer-collision guard: refuse to equip onto an already-occupied
    // layer. Without this, both items end up with the same layer and
    // the paperdoll renders garbage (last-write-wins).
    if (it.layer === targetLayer) {
      state.send(bounce(5));
      return;
    }
    // Hand-mutex — equipping a 2-handed weapon pops the 1-handed slot
    // and vice-versa. Spellbooks (item.spellbook) and shields
    // (item.shield) coexist with a weapon in the other hand, so we
    // only displace fellow WEAPONS.
    if (wantPop && it.layer === otherLayer && it.weapon
        && (targetLayer === 2 || !it.spellbook)) {
      popQueue.push(it);
    }
  }
  for (const popped of popQueue) {
    const pack = backpackOf(world, mob);
    if (!pack) { state.send(bounce(5)); return; }
    removeEquippedIndexItem(mob, popped);
    setItemParent(world, popped, pack.serial); popped.layer = 0;   // A5
    const off = removeEntity({ serial: popped.serial });
    for (const c of nearbyClients(world, mob)) c.client.send(off);
  }
  setItemParent(world, item, mob.serial);
  item.layer = parsed.layer;
  delete item.gridX; delete item.gridY; delete item.gridLocation;
  state.heldItem = null;
  // FAZA BN: dispatch onEquip AFTER fields settle so the script sees
  // the final layer/parent state. Returning truthy means handled but
  // we still broadcast the equip-update so observers see the layer
  // change — the script can't gate paperdoll display.
  dispatchItemEvent(world, item, 'onEquip', mob);
  syncMobileEquipmentIndex(world, mob);
  // FAZA FM: when the equipped item is a weapon, copy its combat
  // descriptor onto the mob so combat-formulas / ranged-arrow consume
  // / slayer matrix pick it up. Layer 1 (right hand) is the primary
  // weapon slot in UO. We read `item.weapon` payload — set by the
  // weapon templates (FAZA FN below).
  if (item.layer === 1 || item.layer === 2) {
    if (item.weapon) {
      mob._resetEquipUntil = Date.now() + 500; // ServUO BaseWeapon.ResetEquipTimer.
      mob._weapon = { ...item.weapon, slayer: item.slayer };
      // Track the weapon item's serial so the swing path can decay its
      // durability on hit. Pure value-copies of `item.weapon` would lose
      // the link back to the source item.
      mob._weaponSerial = item.serial;
      // Bow/crossbow draw on equip — ServUO `BaseRanged.OnEquip` arms
      // the draw timer so the wielder can't instantly fire a pre-loaded
      // arrow the frame they swap from a melee weapon. Move-time stamp
      // alone allowed an "equip + click target on same tick" first shot
      // with no draw delay. Mirrors the move-handler stamp at line 1950.
      if ((item.weapon.range ?? 1) > 1) {
        mob._archeryDrawUntil = Date.now() + 1000;
      }
    }
  }
  // FAZA HK: shield slot (layer 2) sets `_hasShield` for the parry
  // skill gate. Two-handed weapons clear it — they occupy layer 2
  // but aren't shields. ServUO `BaseShield.OnEquip` does the same.
  if (item.layer === 2) {
    if (item.shield) mob._hasShield = true;
    else if (item.weapon) mob._hasShield = false;
  }
  // FAZA HL: dual-wield detection. After this equip, scan for both
  // hand slots filled with weapons (no shield in either) and tag the
  // mob accordingly so combat-formulas can apply the swing penalty.
  // Bug-hunt #3 A3: reverse parent index — ~10 worn slots instead of
  // 110k. We can stop early once both hand slots are resolved.
  if (item.layer === 1 || item.layer === 2) {
    let layer1Weapon = null, layer2Weapon = null, layer2Shield = false;
    const wornIdx = world._childrenByParent?.get?.(mob.serial);
    const wornIter = wornIdx
      ? Array.from(wornIdx, (s) => world.items.get(s)).filter(Boolean)
      : [...world.items.values()].filter((it) => it.parent === mob.serial);
    for (const it of wornIter) {
      if (it.layer === 1 && it.weapon) layer1Weapon = it;
      else if (it.layer === 2) {
        if (it.shield) layer2Shield = true;
        else if (it.weapon) layer2Weapon = it;
      }
    }
    mob._dualWield = Boolean(layer1Weapon && layer2Weapon && !layer2Shield);
  }
  const msg = equipUpdate({
    serial: item.serial, itemId: item.itemId, layer: item.layer,
    parent: mob.serial, hue: item.hue ?? 0,
  });
  for (const c of nearbyClients(world, mob)) c.client.send(msg);
}

/** Collect equipment entries for the SA mobileIncoming packet.
 *
 * Optionally accepts a pre-built reverse index `equipByOwner: Map<serial,
 * Item[]>`. Hot loops (refreshSurroundings, world-join) build the index
 * once and pass it to every mob lookup so the per-mob cost is O(equipped)
 * instead of O(world.items). Without it, refreshSurroundings on a 110k-item
 * shard with 50 nearby mobs walked 5.5 MILLION items per teleport — exactly
 * the "po teleportacji blokuje cala gre" symptom Marcin reported.
 *
 * Falls back to the legacy full walk when no index is supplied so callers
 * outside the hot loops keep working unchanged.
 */
function equipmentFor(world, mob, equipByOwner = null) {
  /** @type {{serial:number, itemId:number, layer:number, hue:number}[]} */
  const out = [];
  if (equipByOwner) {
    const list = equipByOwner.get(mob.serial);
    if (list) {
      for (const it of list) {
        if (!it.layer) continue;
        out.push({
          serial: it.serial, itemId: it.itemId, layer: it.layer, hue: it.hue ?? 0,
        });
      }
    }
    return out;
  }
  // Fast path for runtime loops: reverse parent index gives us the item's
  // children set in O(equipped-items) time.
  const idx = world._childrenByParent?.get?.(mob.serial);
  if (idx) {
    for (const serial of idx) {
      const it = world.items.get(serial);
      if (!it?.layer) continue;
      out.push({
        serial: it.serial, itemId: it.itemId, layer: it.layer, hue: it.hue ?? 0,
      });
    }
    return out;
  }
  for (const it of world.items.values()) {
    if (it.parent === mob.serial && it.layer) {
      out.push({
        serial: it.serial, itemId: it.itemId, layer: it.layer, hue: it.hue ?? 0,
      });
    }
  }
  return out;
}

/** Walk world.items ONCE and bucket by parent. Used by refresh /
 *  bring-into-world paths so the per-mob equipmentFor() lookup is
 *  O(items-per-mob) instead of O(items-in-world). */
function buildEquipByOwner(world) {
  /** @type {Map<number, import('../world/world.js').Item[]>} */
  const map = new Map();
  for (const it of world.items.values()) {
    const p = it.parent;
    if (!p || !it.layer) continue;
    let list = map.get(p);
    if (!list) { list = []; map.set(p, list); }
    list.push(it);
  }
  return map;
}

/**
 * Dress a freshly-created player mobile. Each entry equips an item on the
 * given layer; the item is parented to the mobile so both the paperdoll and
 * the mobile-incoming equipment loop will pick it up.
 *
 * Item ids are the classic newbie outfit (shoes, short pants, tunic) plus
 * a backpack. If the mobile already has equipment (returning player from a
 * save) we skip.
 *
 * @param {import('../world/world.js').World} world
 * @param {import('../world/world.js').Mobile} mob
 */
/**
 * Make sure `mob` has a backpack equipped on layer 21. Returning players
 * sometimes lost theirs (cursor-held during disconnect, for one) and ended
 * up unable to pick anything up. Idempotent — bails out if a backpack already
 * exists on that layer.
 *
 * @param {import('../world/world.js').World} world
 * @param {import('../world/world.js').Mobile} mob
 */
function ensureBackpack(world, mob) {
  // Reverse parent index — walks ≤10 worn items per check. Bug-hunt #3 A4.
  const idx = world._childrenByParent?.get?.(mob.serial);
  if (idx) {
    for (const s of idx) {
      const it = world.items.get(s);
      if (it?.layer === 21) return;
    }
  } else {
    for (const it of world.items.values()) {
      if (it.parent === mob.serial && it.layer === 21) return;
    }
  }
  createItem(world, {
    itemId: 0x0E75,
    hue: 0,
    x: mob.x, y: mob.y, z: mob.z, map: mob.map,
    parent: mob.serial,
    layer: 21,
    gumpId: 0x003C,
    movable: true,
  });
}

function outfitFreshMobile(world, mob) {
  // Reverse parent index — walks worn slots only. Bug-hunt #3 A4.
  const idx = world._childrenByParent?.get?.(mob.serial);
  if (idx) {
    for (const s of idx) {
      const it = world.items.get(s);
      if (it?.layer) return;
    }
  } else {
    for (const it of world.items.values()) {
      if (it.parent === mob.serial && it.layer) return;
    }
  }
  const female = (mob.body | 0) === 401;
  /** @type {Array<{itemId:number, layer:number, hue:number}>} */
  // Layer numbers come straight from tiledata.quality (UO Layer enum):
  //   3 = Shoes, 4 = Pants, 5 = Shirt, 21 = Backpack. The original outfit
  //   table swapped 3 and 4, which silently broke every paperdoll lift on
  //   the client: clicking the pants area routed to layer 4 (where boots
  //   were stored) and the server lifted the boots instead, so the visible
  //   pants stayed on the doll while the user was suddenly carrying shoes.
  const outfit = [
    { itemId: 0x170B, layer:  3, hue: 0x021C }, // Shoes (boots)
    { itemId: 0x1539, layer:  4, hue: 0x03BA }, // Pants (long pants)
    { itemId: 0x1517, layer:  5, hue: 0x0388 }, // Shirt
  ];
  if (female) {
    // Swap the long pants for a plain skirt — same Pants slot.
    outfit[1] = { itemId: 0x1516, layer: 4, hue: 0x03BA };
  }
  // Backpack (layer 21 = Backpack). It's a container, so gumpId != 0 so
  // double-clicking opens the backpack gump.
  outfit.push({ itemId: 0x0E75, layer: 21, hue: 0, gumpId: 0x003C });

  /** @type {Record<number, {serial:number}>} */
  const created = {};
  for (const piece of outfit) {
    const it = createItem(world, {
      itemId: piece.itemId,
      hue: piece.hue,
      x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      parent: mob.serial,
      layer: piece.layer,
      gumpId: piece.gumpId ?? 0,
      movable: true,
    });
    created[piece.layer] = it;
  }

  // Stash a handful of spare clothes inside the backpack so players can
  // dress/undress their character and watch the animation overlays swap
  // in real time. Each entry is a test-only wardrobe item placed at a
  // distinct (gridX, gridY) so they don't stack on top of each other in
  // the backpack gump.
  const backpack = created[21];
  if (backpack) {
    /**
     * @type {Array<{itemId:number, hue:number, gx:number, gy:number}>}
     * Gump grid positions — backpack inner bounds roughly 44..142 × 65..140.
     */
    const wardrobe = [
      { itemId: 0x1F03, hue: 0x0481, gx:  60, gy:  80 }, // Robe (red)
      { itemId: 0x1F03, hue: 0x0021, gx:  80, gy:  80 }, // Robe (blue)
      { itemId: 0x1517, hue: 0x0495, gx: 100, gy:  80 }, // Shirt (green)
      { itemId: 0x1539, hue: 0x0386, gx: 120, gy:  80 }, // Pants (tan)
      { itemId: 0x1711, hue: 0x0000, gx:  60, gy: 110 }, // Leather cap
      { itemId: 0x1712, hue: 0x0000, gx:  80, gy: 110 }, // Boots
      { itemId: 0x1515, hue: 0x0455, gx: 100, gy: 110 }, // Cloak
    ];
    for (const w of wardrobe) {
      createItem(world, {
        itemId: w.itemId,
        hue: w.hue,
        x: 0, y: 0, z: 0, map: mob.map,
        parent: backpack.serial,
        layer: 0,
        gridX: w.gx,
        gridY: w.gy,
        movable: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Context menu dispatch.
// ---------------------------------------------------------------------------

/**
 * Provider registry: functions that look at a (state, target) and return
 * context menu entries or null.
 *
 * @typedef {Object} ContextEntry
 * @property {number} responseId
 * @property {number} cliloc
 * @property {number} [flags]
 * @property {() => void} onPick
 */

function handleContextMenuRequest(state, serial) {
  const provider = state.ctx.contextMenuProvider;
  if (!provider) return;
  const entries = provider(state, serial);
  if (!entries || entries.length === 0) return;
  // Stash callbacks indexed by (serial, responseId).
  if (!state.contextMenuEntries) state.contextMenuEntries = new Map();
  state.contextMenuEntries.set(serial, entries);
  state.send(displayContextMenu({
    serial,
    entries: entries.map((e) => ({
      responseId: e.responseId,
      cliloc: e.cliloc,
      flags: e.flags ?? 0,
    })),
  }));
}

function handleContextMenuResponse(state, serial, responseId) {
  const entries = state.contextMenuEntries?.get(serial);
  if (!entries) return;
  state.contextMenuEntries.delete(serial);
  const entry = entries.find((e) => e.responseId === responseId);
  if (!entry?.onPick) return;
  try { entry.onPick(); }
  catch (e) { console.error('[ctxmenu] pick threw:', e); }
}

export const contextMenus = {
  /**
   * Install a provider. `fn(state, serial)` returns an array of entries or null.
   * @param {import('./net-state.js').NetState['ctx']} ctx
   * @param {(state: import('./net-state.js').NetState, serial:number) => (ContextEntry[]|null)} fn
   */
  setProvider(ctx, fn) { ctx.contextMenuProvider = fn; },
};

// ---------------------------------------------------------------------------
// Vendor (shop) dispatch.
// ---------------------------------------------------------------------------
//
// The server-side vendor state is owned by scripts; each vendor registers
// itself with `vendors.register(serial, {buyStock, onBuy?, onSell?})`. When a
// client double-clicks a vendor (handled in `handleUseReq`), we look up the
// registration and send 0x74 OpenBuyWindow + 0x3C container contents.

/**
 * @typedef {{serial:number, itemId:number, hue:number, amount:number, price:number, description:string}} BuyEntry
 * @typedef {Object} VendorConfig
 * @property {number} vendorSerial
 * @property {() => BuyEntry[]} listStock
 * @property {(state: import('./net-state.js').NetState, picks: {serial:number, amount:number}[]) => void} [onBuy]
 * @property {(state: import('./net-state.js').NetState, picks: {serial:number, amount:number}[]) => void} [onSell]
 */

// ---------------------------------------------------------------------------
// Mobile drag-drop hooks — content scripts register an acceptor callback
// for an NPC's serial. When a player drops an item ON that NPC, handleDrop
// invokes the hook; truthy return = item consumed (tip vendor, give quest
// reward), falsy = refuse and bounce. Mirrors ServUO `Mobile.OnDragDrop`.
// ---------------------------------------------------------------------------

/**
 * @typedef {(state: import('./net-state.js').NetState,
 *            mob: import('../world/world.js').Mobile,
 *            item: import('../world/items.js').Item) => boolean} MobileDragDropHook
 */

/** @type {Map<number, MobileDragDropHook>} */
const mobileDragDropRegistry = new Map();

export const mobileDragDrop = {
  /** @param {number} mobileSerial @param {MobileDragDropHook} fn */
  register(mobileSerial, fn) { mobileDragDropRegistry.set(mobileSerial >>> 0, fn); },
  unregister(mobileSerial) { mobileDragDropRegistry.delete(mobileSerial >>> 0); },
  /**
   * Run the hook (if any) for `mob`. Returns the hook's truthy/falsy
   * verdict, or false when no hook is registered. Errors in the hook
   * are caught and treated as a refusal so a buggy script can't leave
   * the player's heldItem in a stuck state.
   */
  dispatch(state, mob, item) {
    const fn = mobileDragDropRegistry.get(mob.serial >>> 0);
    if (!fn) return false;
    try { return Boolean(fn(state, mob, item)); }
    catch (e) {
      console.error('[mobile-drag-drop] hook threw:', e);
      return false;
    }
  },
};

/** @type {Map<number, VendorConfig>} */
const vendorRegistry = new Map();

export const vendors = {
  /** @param {VendorConfig} cfg */
  register(cfg) { vendorRegistry.set(cfg.vendorSerial, cfg); },
  unregister(serial) { vendorRegistry.delete(serial); },
  get(serial) { return vendorRegistry.get(serial); },
  /**
   * Open the buy window on `state` for the vendor identified by `serial`.
   */
  openBuy(state, serial) {
    const cfg = vendorRegistry.get(serial);
    if (!cfg) return false;
    const stock = cfg.listStock();
    state.send(openBuyWindow({
      vendorSerial: serial,
      entries: stock.map((e) => ({ price: e.price, description: e.description })),
    }));
    // Also send a container-style content packet so the client can render the icons.
    state.send(containerContents(serial, stock.map((e, i) => ({
      serial: e.serial, itemId: e.itemId, hue: e.hue,
      amount: e.amount, gridX: (i % 8) * 18, gridY: Math.floor(i / 8) * 18,
      gridLocation: i,
    }))));
    return true;
  },

  /**
   * Open the sell window: scans the player's backpack for items the vendor
   * will buy back and sends 0x9E. If the vendor has no `listSellable`, every
   * item in the pack is offered at half the vendor's listed price (or 1gp).
   */
  openSell(state, serial) {
    const cfg = vendorRegistry.get(serial);
    if (!cfg || !state.mobile) return false;
    const world = state.ctx.world;
    // Bug-hunt #7 B3: was iterating items with `parent === state.mobile.serial`
    // which is the parent of WORN equipment, not backpack contents — so
    // sell-windows previously listed the player's armor + weapons. ServUO
    // sell-window must scan the layer-21 backpack child set instead.
    let backpackSerial = null;
    const wornIdx = world._childrenByParent?.get?.(state.mobile.serial);
    if (wornIdx) {
      for (const s of wornIdx) {
        const it = world.items.get(s);
        if (it?.layer === 21) { backpackSerial = it.serial; break; }
      }
    }
    if (!backpackSerial) return false;
    const stock = cfg.listStock();
    const priceByItemId = new Map();
    for (const s of stock) {
      const prior = priceByItemId.get(s.itemId) ?? 0;
      if (s.price > prior) priceByItemId.set(s.itemId, s.price);
    }
    /** @type {{serial:number, itemId:number, hue:number, amount:number, price:number, name:string}[]} */
    const entries = [];
    const packIdx = world._childrenByParent?.get?.(backpackSerial);
    const itemIter = packIdx
      ? Array.from(packIdx, (s) => world.items.get(s)).filter(Boolean)
      : Array.from(world.items.values()).filter((it) => it.parent === backpackSerial);
    for (const it of itemIter) {
      const base = priceByItemId.get(it.itemId);
      const price = base ? Math.max(1, Math.floor(base / 2)) : 1;
      entries.push({
        serial: it.serial >>> 0,
        itemId: it.itemId, hue: it.hue ?? 0,
        amount: it.amount ?? 1, price,
        name: it.name ?? `item ${it.itemId.toString(16)}`,
      });
    }
    if (entries.length === 0) return false;
    state.send(vendorSellList({ vendorSerial: serial, entries }));
    return true;
  },
};

function handleBuyRequest(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  let parsed;
  try { parsed = readBuyRequest(pkt); }
  catch { return; }
  const cfg = vendorRegistry.get(parsed.vendorSerial);
  if (!cfg) return;
  if (parsed.flag !== 0x02) return;              // cancelled
  try { cfg.onBuy?.(state, parsed.items); }
  catch (e) { console.error('[vendor] onBuy threw:', e); }
}

function handleSellReply(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  let parsed;
  try { parsed = readSellReply(pkt); }
  catch { return; }
  const cfg = vendorRegistry.get(parsed.vendorSerial);
  if (!cfg) return;
  try { cfg.onSell?.(state, parsed.items); }
  catch (e) { console.error('[vendor] onSell threw:', e); }
}

// ---------------------------------------------------------------------------
// Books dispatch.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BookRecord
 * @property {string} title
 * @property {string} author
 * @property {string[][]} pages
 * @property {boolean} writable
 */

/** @type {Map<number, BookRecord>} */
const bookRegistry = new Map();

export const books = {
  /** @param {number} serial @param {BookRecord} rec */
  register(serial, rec) { bookRegistry.set(serial, rec); },
  unregister(serial) { bookRegistry.delete(serial); },
  get(serial) { return bookRegistry.get(serial); },
  open(state, serial) {
    const rec = bookRegistry.get(serial);
    if (!rec) return false;
    state.send(openBookNew({
      serial, writable: rec.writable, pages: rec.pages.length,
      title: rec.title, author: rec.author,
    }));
    state.send(bookPages({ serial, pages: rec.pages }));
    return true;
  },
};

/**
 * BUGFIX #40 (FAZA BX): the previous handlers happily applied a book
 * write to whichever serial the client supplied, with no proximity or
 * ownership check. Any logged-in account that knew (or guessed) a
 * book's serial could overwrite its pages and title. Now we validate
 * the writer:
 *   - book item must exist in world.items
 *   - either lives on the writer's mobile (parent === serial), OR
 *     sits on the ground within MAX_WRITE_RANGE tiles, OR
 *     lives in a container the writer has open
 * Mirrors the same access pattern handlePickUp uses for items.
 */
const MAX_BOOK_WRITE_RANGE = 3;

function bookWriteAllowed(state, serial) {
  if (state.stage !== Stage.InWorld || !state.mobile) return false;
  const world = state.ctx?.world;
  if (!world) return false;
  const item = world.items?.get?.(serial >>> 0);
  if (!item) return false;          // unknown serial — drop silently
  // (a) carried by writer (paperdoll layer or in their pack chain)
  if (item.parent === state.mobile.serial) return true;
  // (b) on ground next to writer
  if (item.parent == null) {
    if (item.map !== state.mobile.map) return false;
    const dx = Math.abs(item.x - state.mobile.x);
    const dy = Math.abs(item.y - state.mobile.y);
    return Math.max(dx, dy) <= MAX_BOOK_WRITE_RANGE;
  }
  // (c) inside a container the writer has open
  return state.openContainers?.has?.(item.parent) === true;
}

function handleBookPagesInbound(state, pkt) {
  let parsed;
  try { parsed = readBookPages(pkt); }
  catch { return; }
  if (!bookWriteAllowed(state, parsed.serial)) return;
  const rec = bookRegistry.get(parsed.serial);
  if (!rec?.writable) return;
  for (let i = 0; i < parsed.pages.length && i < rec.pages.length; i++) {
    rec.pages[i] = parsed.pages[i];
  }
}

function handleBookHeaderInbound(state, pkt) {
  let parsed;
  try { parsed = readBookHeader(pkt); }
  catch { return; }
  if (!bookWriteAllowed(state, parsed.serial)) return;
  const rec = bookRegistry.get(parsed.serial);
  if (!rec?.writable) return;
  rec.title = parsed.title;
  rec.author = parsed.author;
}

export const _bookWriteAllowedForTest = bookWriteAllowed;

// ---------------------------------------------------------------------------
// Spellbooks — an item whose `gumpId` is the spellbook gump and whose
// `spellbookOffset` + `spellbookContent` fields describe which spells the
// player knows. On double-click we send 0xBF 0x1B so the client renders the
// correct spell icons, then fall through to the normal container open flow.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SpellbookRecord
 * @property {number} serial
 * @property {number} offset            first spell id (1 = Magery)
 * @property {bigint} content           64-bit spell mask
 */

/** @type {Map<number, SpellbookRecord>} */
const spellbookRegistry = new Map();

const SPELLBOOK_OFFSETS_BY_ITEM_ID = Object.freeze({
  0x0E3B: 1,   0x0EFA: 1,    // Magery
  0x2253: 101,               // Necromancy
  0x2252: 201,               // Chivalry / Paladin
  0x238C: 401,               // Bushido
  0x23A0: 501,               // Ninjitsu
  0x2D50: 601,               // Spellweaving
  0x2D9D: 678,               // Mysticism
  0x225A: 700, 0x225B: 700,  // Mastery primers
});

const SPELLBOOK_OFFSET_BY_OPEN_TYPE = Object.freeze([
  1,    // 0 Magery
  101,  // 1 Necromancy
  201,  // 2 Chivalry
  401,  // 3 Bushido
  501,  // 4 Ninjitsu
  601,  // 5 Spellweaving
  678,  // 6 Mysticism
  700,  // 7 Mastery
]);

export const spellbooks = {
  /** @param {SpellbookRecord} rec */
  register(rec) { spellbookRegistry.set(rec.serial, rec); },
  unregister(serial) { spellbookRegistry.delete(serial); },
  get(serial) { return spellbookRegistry.get(serial); },
  /** Toggle whether a given spell is learned (spellId is absolute). */
  learn(serial, spellId, known = true) {
    const rec = spellbookRegistry.get(serial);
    if (!rec) return false;
    const bit = BigInt(spellId - rec.offset);
    if (bit < 0n || bit > 63n) return false;
    const mask = 1n << bit;
    rec.content = known ? (rec.content | mask) : (rec.content & ~mask);
    return true;
  },
  /** True if the book knows the given spell id. */
  knows(serial, spellId) {
    const rec = spellbookRegistry.get(serial);
    if (!rec) return false;
    const bit = BigInt(spellId - rec.offset);
    if (bit < 0n || bit > 63n) return false;
    return (rec.content & (1n << bit)) !== 0n;
  },
  /** Send 0xBF 0x1B to the client for the given spellbook. */
  sendContent(state, serial) {
    const rec = spellbookRegistry.get(serial);
    if (!rec) return false;
    state.send(extNewSpellbookContent({
      serial: rec.serial, offset: rec.offset, content: rec.content,
    }));
    return true;
  },
};

function ensureSpellbookRegisteredFromItem(item) {
  if (!item || spellbookRegistry.has(item.serial)) return false;
  const offset = SPELLBOOK_OFFSETS_BY_ITEM_ID[item.itemId | 0];
  if (offset == null) return false;
  // Default discovered books to "all spells learned" so the gump shows
  // the grid filled in. Admins can [teach to remove specific spells.
  spellbooks.register({ serial: item.serial, offset, content: 0xFFFFFFFFFFFFFFFFn });
  item.spellbook = true;
  return true;
}

function openOwnedSpellbookByType(state, type) {
  if (state.stage !== Stage.InWorld || !state.mobile) return false;
  const world = state.ctx?.world;
  if (!world) return false;
  const offset = SPELLBOOK_OFFSET_BY_OPEN_TYPE[type & 0xff] ?? 1;
  const pack = backpackOf(world, state.mobile);
  const packSerial = pack?.serial >>> 0;

  const ownsItem = (item) => {
    if (!item) return false;
    let parent = item.parent >>> 0;
    for (let hops = 0; parent && hops < 8; hops++) {
      if (parent === (state.mobile.serial >>> 0) || (packSerial && parent === packSerial)) return true;
      parent = world.items.get(parent)?.parent >>> 0;
    }
    return false;
  };

  for (const item of world.items.values()) {
    ensureSpellbookRegisteredFromItem(item);
    const rec = spellbookRegistry.get(item.serial);
    if (!rec || rec.offset !== offset) continue;
    if (!ownsItem(item)) continue;
    spellbooks.sendContent(state, item.serial);
    return true;
  }

  state.sendSystemMessage?.('You do not have that spellbook.');
  return false;
}

// ---------------------------------------------------------------------------
// Combat atoms — warmode, damage, animation helpers.
// ---------------------------------------------------------------------------

function handleWarmodeReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const { warmode: on } = readWarmode(pkt);
  const mob = state.mobile;
  mob.flags = on ? (mob.flags | 0x40) : (mob.flags & ~0x40);
  // Echo to the client + nearby observers. ClassicUO `GameActions.
  // RequestWarMode` plays a random combat music track (id 38/39/40)
  // on war-enter and stops it on war-exit — handled client-side off
  // the 0x72 echo, NOT a server-emitted SFX. No PlaySound here.
  state.send(warmode(on));
  const world = state.ctx.world;
  // Compute equipment once — each mobileIncoming below carries the same
  // payload, and equipmentFor() walks all world.items each call.
  const myEquipment = equipmentFor(world, mob);
  for (const c of nearbyClients(world, mob, mob)) {
    c.client.send(mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue, flags: mob.flags,
      notoriety: mob.notoriety,
      equipment: myEquipment,
    }));
  }
  // Dropping warmode cancels any ongoing auto-attack. Bug-hunt #9 #12 —
  // also clear `nextSwingAt` so a rapid war-on/off + re-target exploit
  // can't fire the first swing without the 500ms wind-up window.
  if (!on) {
    state.combatant = 0;
    state.nextSwingAt = 0;
  }
}

// ---- Attack request (0x05) ----------------------------------------------
//
// The classic client sends 0x05 when the player single-clicks an enemy in
// war mode, or when auto-attack targets a new mobile. We mark the target
// as the combatant for subsequent swings; swing cadence is driven by the
// combat scheduler.

function handleAttackReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  if (state.mobile.ghost) return;
  const r = new PacketReader(pkt);
  r.readU8();
  const serial = r.readU32();
  // Damageable world item path — beacons, totems, banners. Apply one
  // weapon swing's worth of damage via the systems/housing/damageable-items.js
  // module. Items don't enter the regular combat loop (no swing timer,
  // no skill gain) — single-shot per attack.
  const item = state.ctx.world.items?.get?.(serial);
  if (item?.damageable) {
    const dmgSys = state.ctx?.systems?.damageableItems;
    if (dmgSys?.damageItem) {
      const dx = Math.abs(item.x - state.mobile.x);
      const dy = Math.abs(item.y - state.mobile.y);
      if (item.map === state.mobile.map && Math.max(dx, dy) <= 2) {
        const wpn = state.mobile._weapon;
        const dmg = wpn ? (8 + Math.floor(Math.random() * 12)) : 4;
        const r = dmgSys.damageItem(state.ctx.world, item, dmg, state.mobile);
        state.sendSystemMessage?.(r.destroyed
          ? `You destroy ${item.name ?? 'it'}!`
          : `You strike ${item.name ?? 'it'} (${r.hpLeft} HP left).`);
      }
    }
    state.combatant = 0;
    return;
  }
  const target = state.ctx.world.mobiles.get(serial);
  if (!target || target === state.mobile) { state.combatant = 0; return; }
  if ((target.hp ?? 0) <= 0) { state.combatant = 0; return; }
  // Bug-hunt #10 #8 — reject cross-facet / out-of-range targets so
  // attackers can't pin `combatant` to a mob on another map. Combat
  // tick would skip but `nextSwingAt = now+500` + the criminal flag
  // bump from notoriety wiring would still get applied.
  if (target.map !== state.mobile.map) { state.combatant = 0; return; }
  const dx = Math.abs(target.x - state.mobile.x);
  const dy = Math.abs(target.y - state.mobile.y);
  if (Math.max(dx, dy) > 12) { state.combatant = 0; return; }
  state.combatant = serial;
  state.nextSwingAt = Date.now() + 500; // brief wind-up before first swing
}

// Pick the skill id of the mob's *strongest* weapon skill — that's the
// one that drove `effectiveWeaponSkill` and is therefore the one a hit
// should reward. Falls back to Wrestling for skill-less monsters so a
// `tryGain` call at least no-ops cleanly.
function primaryWeaponSkillId(mob) {
  let bestId = WEAPON_SKILLS.WRESTLING;
  let bestVal = -1;
  for (const id of Object.values(WEAPON_SKILLS)) {
    const v = effectiveSkill(mob, id);
    if (v > bestVal) { bestVal = v; bestId = id; }
  }
  return bestId;
}

// Friendly names for the gain-notification system message. Covers only
// the skills we currently award gains for; if more get wired up later,
// add them here. Anything not in the map falls back to "your skill".
const SKILL_NAME_FOR_GAIN = {
  [SKILL_TACTICS]: 'Tactics',
  [SKILL_ANATOMY]: 'Anatomy',
  [SKILL_PARRYING]: 'Parrying',
  [WEAPON_SKILLS.WRESTLING]: 'Wrestling',
  [WEAPON_SKILLS.SWORDSMANSHIP]: 'Swordsmanship',
  [WEAPON_SKILLS.MACEFIGHTING]: 'Mace Fighting',
  [WEAPON_SKILLS.FENCING]: 'Fencing',
  [WEAPON_SKILLS.ARCHERY]: 'Archery',
  26: 'Magery',
};

/**
 * Try to bump a skill, and on success push a system message + a 0x3A
 * single-skill update to the owning client (so the skill window
 * refreshes without a full re-list). The mob's `skills` dict is
 * mutated by `tryGain` itself; this just notifies.
 */
function awardSkill(mob, skillId, difficulty) {
  const next = tryGain(mob, skillId, difficulty);
  if (next === null) return;
  if (!mob.client) return;
  const label = SKILL_NAME_FOR_GAIN[skillId] ?? 'a skill';
  // Hue 0x59 is the canonical ServUO/CUO skill-advance blue — matches
  // OSI's "You feel that you have advanced…" line so it visibly
  // separates from regular system messages.
  mob.client.sendSystemMessage?.(`You feel more confident in your ${label}.`, 0x59);
  // Visual sparkle FX — 0x375A is the ServUO "skill-up sparkle" animation
  // (small star-burst). Mirrors the "Confidence/Knowledge" feedback OSI
  // emits when a skill ticks up. Best-effort: silent if huedEffect isn't
  // available (older protocol versions).
  try {
    const fx = huedEffect?.({
      kind: 0,                                       // FixedFrom
      from: mob.serial, to: 0,
      itemId: 0x375A, hue: 0x59, renderMode: 0,
      fromX: mob.x, fromY: mob.y, fromZ: mob.z,
      toX: mob.x, toY: mob.y, toZ: mob.z,
      speed: 5, duration: 16, fixedDirection: 1, explodes: 0,
    });
    if (fx) mob.client.send(fx);
  } catch { /* huedEffect optional */ }
  // 0x3A type 0xFF is the "single skill update" form — much smaller than
  // re-sending the whole list and lets the client animate the +1. Wire
  // id is 1-indexed (client maps back via `id - 1`).
  mob.client.send(sendSkills({
    type: 0xFF,
    skills: [{ id: skillId, value: next, base: next, lock: skillLockFor(mob, skillId), cap: skillCapRaw(mob, skillId) }],
  }));
}

function isWorldLike(value) {
  return !!value && typeof value === 'object'
    && value.mobiles instanceof Map && value.items instanceof Map;
}

function looksLikeDamageOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'attacker' in value || 'source' in value || 'caster' in value
    || 'damageType' in value || 'type' in value || 'armorPierce' in value;
}

const DAMAGE_TYPE_ALIASES = Object.freeze({
  phys: 'physical',
  physical: 'physical',
  fire: 'fire',
  cold: 'cold',
  poison: 'poison',
  pois: 'poison',
  energy: 'energy',
  engy: 'energy',
});

function normalizeDamageTypeName(type) {
  if (!type) return null;
  if (typeof type === 'string') {
    const key = type.toLowerCase();
    return DAMAGE_TYPE_ALIASES[key] ?? key;
  }
  if (typeof type !== 'object') return null;
  let best = null;
  let bestVal = -Infinity;
  for (const [key, value] of Object.entries(type)) {
    const n = Number(value) || 0;
    if (n > bestVal) {
      bestVal = n;
      best = normalizeDamageTypeName(key);
    }
  }
  return best;
}

function looksLikeDamageType(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((key) =>
    Object.prototype.hasOwnProperty.call(DAMAGE_TYPE_ALIASES, String(key).toLowerCase()));
}

function normalizeDamageArgs(mobArg, amountArg, attackerArg = null, extraArg = null) {
  let mob = mobArg;
  let amount = amountArg;
  let attacker = null;
  let options = {};
  let damageType = null;

  if (mobArg && typeof mobArg === 'object' && !('serial' in mobArg)
      && (('target' in mobArg) || ('victim' in mobArg) || ('mob' in mobArg))
      && amountArg == null) {
    options = { ...mobArg };
    mob = mobArg.target ?? mobArg.victim ?? mobArg.mob ?? null;
    amount = mobArg.amount ?? mobArg.damage ?? 0;
    attacker = mobArg.attacker ?? mobArg.source ?? mobArg.caster ?? null;
  } else if (typeof attackerArg === 'string') {
    damageType = attackerArg;
  } else if (looksLikeDamageOptions(attackerArg)) {
    options = { ...attackerArg };
    attacker = attackerArg.attacker ?? attackerArg.source ?? attackerArg.caster ?? null;
  } else if (looksLikeDamageType(attackerArg)) {
    damageType = attackerArg;
  } else {
    attacker = attackerArg ?? null;
  }

  if (extraArg != null) {
    if (typeof extraArg === 'string' || looksLikeDamageType(extraArg)) {
      damageType = extraArg;
    } else if (looksLikeDamageOptions(extraArg)) {
      options = { ...options, ...extraArg };
      attacker = extraArg.attacker ?? extraArg.source ?? extraArg.caster ?? attacker;
    }
  }

  damageType = damageType ?? options.damageType ?? options.type ?? null;
  return {
    mob,
    amount,
    attacker,
    damageType,
    damageTypeName: normalizeDamageTypeName(damageType),
    options,
  };
}

function broadcastMobileRefresh(world, mob) {
  const pkt = mobileMoving({
    serial: mob.serial,
    body: mob.body,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    direction: mob.direction ?? 0,
    hue: mob.hue ?? 0,
    flags: mob.flags ?? 0,
    notoriety: mob.notoriety ?? 1,
  });
  for (const other of nearbyClients(world, mob, mob)) other.client.send(pkt);
  mob.client?.send?.(pkt);
}

function forceDamageDismount(world, mob) {
  const petSerial = mob?.mountedFrom >>> 0;
  if (!petSerial) return false;
  const pet = world?.mobiles?.get?.(petSerial);
  mob.body = mob.mountedOriginalBody ?? (mob.sex === 1 ? 0x0191 : 0x0190);
  delete mob.mountedFrom;
  delete mob.mountedOriginalBody;
  mob.mounted = false;
  mob._dismountedUntil = Date.now() + 4_000;
  if (pet) {
    delete pet.mounted;
    pet.x = mob.x; pet.y = mob.y; pet.z = mob.z; pet.map = mob.map;
    world.sectors?.moveMobile?.(pet);
    const incoming = mobileIncoming({
      serial: pet.serial,
      body: pet.body,
      x: pet.x,
      y: pet.y,
      z: pet.z,
      direction: pet.direction ?? 0,
      hue: pet.hue ?? 0,
      flags: pet.flags ?? 0,
      notoriety: pet.notoriety ?? 1,
      equipment: [],
    });
    for (const other of nearbyClients(world, pet)) other.client.send(incoming);
  }
  broadcastMobileRefresh(world, mob);
  mob.client?.sendSystemMessage?.('The blow knocks you from your mount!');
  return true;
}

function decodeClassicCreateGenderRace(genderRace, extended) {
  const value = genderRace | 0;
  const female = (value & 1) === 1;
  // ServUO decodes modern 0xF8 / SA 0x00 packets from ClassicUO's
  // RaceType byte: 2/3 human, 4/5 elf, 6/7 gargoyle. Pre-SA legacy
  // packets used 0/1 human and 2/3 elf.
  const decodedRace = (extended || value >= 4)
    ? (value < 4 ? 0 : ((value >> 1) - 1))
    : (value >> 1);
  return {
    female,
    race: Math.max(0, Math.min(2, decodedRace | 0)),
  };
}

export const combat = {
  // Re-export the pure formula functions on the combat namespace so scripts
  // (monster AI, custom abilities) can roll a swing without importing from
  // server internals. Treat these as the canonical implementation — the
  // built-in player auto-attack and aggressive AI both go through them.
  hitChance,
  rollDamage,
  swingDelayMs,
  // Skill-gain helpers exposed so scripts can award gains on custom uses
  // (crafting, lockpicking, spell casts) without re-implementing the
  // bell curve. `awardSkill` is the convenience form that also pushes a
  // system message + 0x3A delta to the owning client; `tryGain` is the
  // raw form for callers that want to handle notification themselves.
  tryGain,
  awardSkill,
  /**
   * Apply (tracked) damage to a mobile, broadcast 0x0B to nearby viewers and
   * update health on the target's own status bar.
   *
   * @param {import('../world/world.js').World} world
   * @param {import('../world/world.js').Mobile} mob
   * @param {number} amount
   */
  damage(world, mobArg, amountArg, attackerArg = null, extraArg = null) {
    const normalized = normalizeDamageArgs(mobArg, amountArg, attackerArg, extraArg);
    const mob = normalized.mob;
    const attacker = normalized.attacker;
    const damageType = normalized.damageType ?? 'physical';
    const damageTypeName = normalized.damageTypeName ?? 'physical';
    const damageOptions = normalized.options;
    if (!mob) return 0;
    // BUGFIX #81 (FAZA DM): clamp damage at 0. Negative amounts would
    // have HEALED the victim (hp - (-5) = hp + 5) — every damage path
    // that ever passed a stale negative number (e.g. armor reduction
    // wrapping below zero) was a healing exploit waiting to happen.
    let amount = Math.max(0, normalized.amount | 0);
    if (amount === 0) return 0;
    // [invul / [god — GM invulnerability flag. Mob takes zero damage
    // from every source. ServUO `Mobile.OnDamage` short-circuits on
    // `Blessed = true`; we mirror via the existing `invulnerable` field
    // (already set by `[guards`, boat tillermen, vendors).
    if (mob.invulnerable) return 0;
    // FAZA DM: Young player PK immunity.
    if (attacker && !canDamageYoung(attacker, mob)) {
      attacker.client?.sendSystemMessage?.('You may not harm a Young player.');
      return 0;
    }
    // Audit #37 P1 #5 — Attune Weapon absorb pool. ServUO
    // `AttuneWeapon.TryAbsorb` drains incoming melee damage. The pool
    // size = `skill/2 + 14 + focusLevel*10`. We can't cheaply
    // distinguish melee vs spell at this central hook, so the pool
    // absorbs ALL incoming damage — harsh-er than ServUO but a one-
    // touch fix vs the previous no-op flag. Buff expires when the
    // pool runs out OR the 60-s timer lapses (whichever first).
    if ((mob._attuneUntil ?? 0) > Date.now() && (mob._attuneAbsorb | 0) > 0) {
      const pool = mob._attuneAbsorb | 0;
      const absorbed = Math.min(pool, amount);
      amount -= absorbed;
      mob._attuneAbsorb = pool - absorbed;
      if (mob._attuneAbsorb <= 0) {
        mob._attuneAbsorb = 0;
        mob._attuneUntil = 0;
        mob.client?.sendSystemMessage?.('Your attuned weapon\'s ward dissipates.');
      }
      if (amount <= 0) return 0;
    }
    // Audit #38 P2 #5 — Bushido Confidence interrupt. ServUO
    // `Confidence.cs:105 StopRegenerating` cancels the regen timer
    // when the buffed mob takes damage. Was: ticked unconditionally
    // for 8 s even under sustained AOE. Cheap one-touch fix at the
    // central damage hook.
    if ((mob.confidenceUntil ?? 0) > Date.now()) {
      mob.confidenceUntil = 0;
      mob.confidenceRegen = 0;
      mob.client?.sendSystemMessage?.('Your confidence is shattered by the blow.');
    }
    if (world?._peerlessBossesSystem?.invokeBossDamaged) {
      try {
        amount = Math.max(0, world._peerlessBossesSystem.invokeBossDamaged(
          mob,
          attacker,
          amount,
          { damageType, lastDamageType: damageTypeName, options: damageOptions },
        ) | 0);
      } catch (e) {
        console.error('[combat.damage] peerless onDamaged threw:', e?.message ?? e);
      }
      if (amount === 0) return 0;
    }
    try {
      dispatchXmlAttachment(mob, 'onAttacked', {
        world, attacker, amount, damageType, damageTypeName, options: damageOptions,
      });
      if (attacker) {
        dispatchXmlAttachment(attacker, 'onAttack', {
          world, defender: mob, target: mob, amount, damageType, damageTypeName,
          options: damageOptions,
        });
      }
    } catch (e) {
      console.error('[combat.damage] xml attachment dispatch threw:', e?.message ?? e);
    }
    // Audit #34 P3 #8 — stamp last-attacker so pets in non-guard modes
    // can auto-defend their master. ServUO `BaseCreature.OnDamage`
    // propagates the aggressor; we mirror with a single field pair
    // read by `npcs/pet.js`. Skip self-damage (DoT proc on self) so
    // the pet doesn't try to attack its own master.
    if (attacker && attacker !== mob) {
      mob._lastDamageBy = attacker.serial | 0;
      mob._lastDamageAt = Date.now();
    }
    // Server audit #28 P1 #2 — criminal flag on any harmful action
    // against an innocent. ServUO `Mobile.DoHarmful` is called from
    // EVERY damage path (single-target spell, AoE splash, weapon
    // hit). Without this, Thunderstorm / Wildfire / Meteor Swarm
    // splash damage on blues never flagged the caster criminal, so
    // PK splashed guard zones without guards reacting. Innocent + a
    // human (not pet, not your own party) + alive → flag.
    if (attacker && attacker !== mob && attacker.client
        && mob.client && (mob.notoriety ?? 1) === 1
        && (attacker.partyOf == null || attacker.partyOf !== mob.partyOf)
        // PvP Arena suppression — combatants inside the same arena match
        // can freely damage each other without flagging. Mirrors ServUO
        // `DuelContext.AllowHarmful` returning true for paired duelists.
        && !canArenaAttack(attacker, mob)) {
      flagCriminal(attacker);
    }
    // Heat-of-Battle stamp — every successful damage application
    // refreshes the 2-minute combat window on both attacker and
    // victim. Gameplay gates (logout hold, recall/sacred-journey
    // block, stable refuse, PvP loot rights) read `_combatUntil`
    // through `aggression.isInCombat`. ServUO `Mobile.RegisterDamage`
    // is the equivalent hook.
    if (attacker && attacker !== mob) {
      try { stampAggression(world, attacker, mob); }
      catch { /* aggression is advisory — never fatal */ }
    }
    // FAZA DX: stealth break-on-attack. Hidden attackers reveal the
    // moment they land a hit — mirrors ServUO `Mobile.OnDamage` calling
    // `RevealingAction()`. Without this, a hidden mage could fire a
    // chain of mind-blasts from invisibility, which broke combat
    // economy badly.
    if (attacker?.hidden) {
      attacker.hidden = false;
      attacker.stealthSteps = 0;
      attacker.flags = (attacker.flags | 0) & ~0x80;
      const reveal = mobileIncoming({
        serial: attacker.serial, body: attacker.body,
        x: attacker.x, y: attacker.y, z: attacker.z,
        direction: attacker.direction, hue: attacker.hue,
        flags: attacker.flags, notoriety: attacker.notoriety,
        equipment: [],
      });
      for (const other of nearbyClients(world, attacker, attacker)) {
        other.client.send(reveal);
      }
      attacker.client?.sendSystemMessage?.('You are no longer hidden.');
    }
    // FAZA item-system 2026-05-05: record the hit on the victim's damage
    // ledger BEFORE we apply the HP delta. The entry is needed even when
    // this swing is the killing blow — corpse / loot-ownership code reads
    // damageEntries to decide who earns the kill credit.
    // Audit #43 P1-7 — pass world so recordDamage can walk the
    // controlMaster chain and also credit the master (looting rights /
    // kill credit no longer go solely to the pet's serial).
    if (attacker) recordDamage(mob, attacker, amount, Date.now(), world);
    // Mana Shield (mastery 702): mana absorbs damage at 1:1 until empty.
    // ServUO `Spells/SkillMasteries/ManaShield`. Drain mana first; only
    // overflow hits HP. Auto-expires when mana hits 0.
    const manaShieldUntil = Math.max(mob.manaShieldUntil | 0, mob._manaShieldUntil | 0);
    if (manaShieldUntil > Date.now() && (mob.mana | 0) > 0) {
      const absorbed = Math.min(amount, mob.mana | 0);
      mob.mana -= absorbed;
      amount -= absorbed;
      if (mob.client && typeof manaUpdate === 'function') {
        mob.client.send(manaUpdate({
          serial: mob.serial, current: mob.mana, max: mob.manaMax ?? 50,
        }));
      }
      if (mob.mana <= 0) {
        mob.manaShieldUntil = 0;
        mob._manaShieldUntil = 0;
      }
      if (amount <= 0) return 0;
    }
    // Body Guard (mastery 710): -30 % incoming damage while active.
    if (Math.max(mob.bodyGuardUntil | 0, mob._bodyGuardUntil | 0) > Date.now()) {
      amount = Math.max(1, Math.floor(amount * 0.7));
    }
    mob._lastDamageType = damageType;
    mob._lastDamageTypeName = damageTypeName;
    world?.events?.emit?.('combat:damage', {
      victim: mob,
      target: mob,
      attacker,
      source: attacker,
      amount,
      damageType,
      damageTypeName,
      options: damageOptions,
    });
    mob.hp = Math.max(0, (mob.hp ?? 0) - amount);
    if (mob.hp > 0 && mob.mountedFrom) {
      const threshold = Math.max(1, Math.floor((mob.hpMax ?? 50) * 0.2));
      if (mob.hp <= threshold) forceDamageDismount(world, mob);
    }
    // ServUO Spell.Disturb on damage — interrupt the cast bar with a
    // half-mana refund (handled by disturbCast). Without this, casters
    // are immune to interrupt during the 1.5s cast bar — trivial PvP
    // exploit. Disturb runs after HP deduction so a killing blow still
    // counts but no further effect can fire.
    // Audit #40 P2 #11 — Protection spell suppresses the disrupt path
    // (its actual ServUO mechanic). Indefinite buff; toggle-off via
    // re-cast. Was: Protection had no effect on this code path so the
    // spell was a flat no-op.
    if (!((mob._protectionUntil ?? 0) > Date.now())) {
      disturbCast(mob);
    }
    // ServUO `BaseCreature.OnDamage` aggro hook — when an AI-bound mob
    // takes damage from a hostile attacker, wake its behavior to
    // pursue them. Without this an orc/dragon/whatever just stands
    // still while a mage 10 tiles away nukes it (because findNearestPlayer
    // gates on cfg.aggroRange ~6 tiles, far below typical spell range).
    // Marcin: "puścilem kilka zaklęć które mu zżerały HP i nadal stał".
    if (attacker && attacker !== mob && (mob.hp | 0) > 0) {
      const aiBindings = world._ai?.bindings;
      const binding = aiBindings?.get?.(mob.serial);
      if (binding?.state) {
        const st = binding.state;
        const cur = st.targetSerial ? world.mobiles.get(st.targetSerial) : null;
        const noCurrent = !cur || (cur.hp ?? 0) <= 0 || cur.map !== mob.map;
        // ServUO `BaseCreature.OnDamage` updates the aggressor list and
        // re-runs `AcquireFocusMob` per think, so a 2-5 player gang on
        // one mob shares aggro instead of one player tanking forever.
        // We approximate with a closer-aggressor swap: if the new
        // attacker is materially closer to us than the current target
        // (≤ 0.7×) AND we're not already adjacent to the current
        // target (1-tile melee shouldn't break aggro lock for a
        // ranged-spell flicker), retarget. Threat decay still flows
        // through `_lastDamageBy/_lastDamageAt`; this is just the
        // immediate switch hook.
        let switchTo = null;
        if (noCurrent) {
          switchTo = attacker;
        } else if (cur && attacker !== cur) {
          const curDist = Math.max(Math.abs(cur.x - mob.x), Math.abs(cur.y - mob.y));
          const newDist = Math.max(Math.abs(attacker.x - mob.x), Math.abs(attacker.y - mob.y));
          // Only break the lock when the new aggressor is clearly closer
          // (≤ 0.7×) AND we're not already in melee with the current
          // target. The same-distance and farther cases keep the
          // existing target to avoid 4-player target ping-pong.
          if (curDist > 1 && newDist * 10 <= curDist * 7) switchTo = attacker;
        }
        if (switchTo) {
          st.targetSerial = switchTo.serial >>> 0;
          st.nextAttackAt = 0;     // swing as soon as the cooldown allows
          st.nextStepAt   = 0;     // start chasing right now
          st.path = null;          // drop stale A* route to old target
        }
      }
    }
    // BUGFIX #55 (FAZA CM): broadcast 0xA1 healthUpdate to nearby
    // observers as well as the victim — earlier code only sent it to
    // mob.client, so overhead bars and dragged-out status bars on
    // other players' screens kept the previous HP value while the
    // floating "-15" damage number flew up. The result was bars that
    // updated only on the next combat tick (0x77 mobileMoving carries
    // body/hue but no HP). Now the bar sync is monotonic with damage.
    const hp = healthUpdate({
      serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
    });
    const dmg = damagePacket({ serial: mob.serial, amount });
    for (const c of nearbyClients(world, mob)) {
      c.client.send(dmg);
      c.client.send(hp);
    }
    if (mob.client) {
      mob.client.send(hp);
    }
    // ServUO `Mobile.OnDamage` calls `Kill()` from inside the Hits
    // setter whenever HP drops to ≤0. We have no setter-driven hook —
    // every call site of `combat.damage` would otherwise need to
    // remember to call `corpse.killMobile` itself. The player
    // auto-attack swing path does (main.js:731 onKill), the reflect
    // rider does (line 5520 below), but AI spell casts / DoTs /
    // mastery procs / NPC-on-NPC damage do NOT. Centralise here so
    // every damage source fires the canonical death cascade. Skip
    // ghosts (already dead) and any mob that lacks a corpse pipeline
    // (test fixtures without `world._corpse` injected).
    if (mob.hp <= 0 && !mob.ghost && world?._corpse?.killMobile) {
      try { world._corpse.killMobile(world, mob, attacker); }
      catch (e) { console.error('[combat.damage] killMobile threw:', e?.message ?? e); }
    }
    return amount;
  },
  /**
   * Play an animation on a mobile for all viewers.
   */
  animate(world, mob, action, opts = {}) {
    const bytes = playerAnimation({ serial: mob.serial, action, ...opts });
    for (const c of nearbyClients(world, mob, mob)) {
      c.client?.send?.(bytes);
    }
    mob.client?.send?.(bytes);
  },

  /**
   * Play a sound effect at the mobile's location for every nearby viewer
   * (and the actor themselves if they're a player). Uses 0x54 PlaySound.
   * Volume is the classic 0xFF max; the client maps /100 to float gain.
   *
   * @param {import('../world/world.js').World} world
   * @param {import('../world/world.js').Mobile} mob
   * @param {number} soundId  UO sound id (see ServUO Scripts/Misc/SoundList.cs)
   */
  playSoundNear(world, mob, soundId) {
    const bytes = playSound({
      soundId: soundId & 0xFFFF, mode: 0, volume: 0xFF,
      x: mob.x, y: mob.y, z: mob.z,
    });
    // BH #14 B1 — nearbyClients(world, mob) defaults `self = null`, so
    // the `m === self` skip never triggers and the mob itself is
    // yielded. The second send was a deliberate compensation but it
    // produced a DOUBLE sound on the caster. Pass `mob` as 3rd arg.
    for (const c of nearbyClients(world, mob, mob)) c.client.send(bytes);
    if (mob.client) mob.client.send(bytes);
  },

  /**
   * Apply post-hit durability damage. ServUO `BaseWeapon.OnHit` and
   * `BaseArmor.OnHit` reduce HP on the gear piece — once durability
   * reaches zero the item shatters. Probabilities tuned to AOS:
   *   * weapon: 25 % chance, -1 hp
   *   * armour: 25 % chance, -1 hp on one random equipped piece
   * Items without a `durability` field are assumed indestructible
   * (NPC starter kits, magic-locked decor) and skipped.
   */
  _decayDurability(world, attacker, defender) {
    const decay = (item) => {
      if (!item || item.durability == null) return;
      item.durability = (item.durability | 0) - 1;
      if (item.durability > 0) return;
      // Shatter — broadcast removal + system message to the wearer.
      const owner = world.mobiles.get(item.parent >>> 0);
      const rm = removeEntity(item.serial);
      if (owner) {
        owner.client?.send?.(rm);
        owner.client?.sendSystemMessage?.('Your gear has worn out and broken!');
        for (const c of nearbyClients(world, owner)) c.client.send(rm);
        if (owner.equipment?.delete) owner.equipment.delete(item.layer);
        if (owner._weaponSerial === item.serial) {
          owner._weapon = null;
          owner._weaponSerial = 0;
        }
      }
      try { itemsMod.destroyItem(world, item.serial); }
      catch { /* item already gone */ }
    };
    if (Math.random() < 0.25 && attacker._weaponSerial) {
      decay(world.items.get(attacker._weaponSerial >>> 0));
    }
    if (Math.random() < 0.25) {
      const armorLayers = [4, 5, 6, 7, 13, 17, 19, 22, 23, 24]; // pants/shirt/helm/gloves/torso/tunic/arms/robe/skirt/legs
      const candidates = [];
      // Server parity #12 #3: was full world.items walk per armor-decay
      // roll (25% per hit). Use reverse parent index.
      const idx = world._childrenByParent?.get?.(defender.serial);
      const iter = idx
        ? Array.from(idx, (s) => world.items.get(s)).filter(Boolean)
        : (function* () { for (const it of world.items.values()) yield it; })();
      for (const it of iter) {
        if (!idx && it.parent !== defender.serial) continue;
        if (it.durability == null) continue;
        if (!armorLayers.includes(it.layer | 0)) continue;
        candidates.push(it);
      }
      if (candidates.length > 0) {
        decay(candidates[Math.floor(Math.random() * candidates.length)]);
      }
    }
  },

  /**
   * Process auto-attack swings for every player-controlled mobile with a
   * `combatant` set on its NetState. Call this at a steady cadence (≈100–
   * 200ms granularity is fine; per-state swing intervals gate the rate).
   *
   * @param {import('../world/world.js').World} world
   * @param {(world:import('../world/world.js').World, mob:import('../world/world.js').Mobile) => void} [onKill]
   */
  tick(world, onKill) {
    const now = Date.now();
    // ServUO processes combatants/NetStates, not every NPC in Map.Mobiles.
    // The server already maintains an authoritative online-mobile index;
    // use it here because this loop runs at 10 Hz on populated shards.
    const online = typeof world.onlineMobiles === 'function'
      ? world.onlineMobiles()
      : world.mobiles.values();
    for (const mob of online) {
      const state = mob.client;
      if (!state || state.stage !== Stage.InWorld) continue;
      const combatant = state.combatant >>> 0;
      if (!combatant) continue;
      if ((mob.flags & 0x40) === 0) { state.combatant = 0; continue; }
      const target = world.mobiles.get(combatant);
      if (!target || target === mob || (target.hp ?? 0) <= 0) {
        state.combatant = 0; continue;
      }
      // Audit #35 P3 #14 — combat leash. ServUO `Mobile.CheckCombatants`
      // clears `Combatant` once target is unreachable (different map or
      // out of perception range). Was: the swing-distance check
      // `continue`d without ever resetting `state.combatant`, so a
      // player who war-clicked an enemy then walked 100 tiles away
      // auto-resumed attacking on re-entry. Drop combatant when target
      // exceeds 18 tiles (ServUO's perception leash) or is off-facet.
      if (target.map !== mob.map) { state.combatant = 0; continue; }
      const dx = Math.abs(target.x - mob.x);
      const dy = Math.abs(target.y - mob.y);
      if (Math.max(dx, dy) > 18) { state.combatant = 0; continue; }
      // BUGFIX #106 (FAZA FJ): the previous adjacency gate blocked
      // every ranged weapon — the only way to hit was to be on a tile
      // adjacent to the target. ServUO `BaseRanged.cs` checks the
      // wielded weapon's MaxRange before the combat tick. Read the
      // attacker's weapon range from `mob._weapon.range` (set by the
      // equipment layer when a bow is wielded). Default melee = 1.
      const weaponRange = mob._weapon?.range ?? 1;
      if (dx > weaponRange || dy > weaponRange) continue;
      // Audit #37 P3 #6 — ServUO `BaseRanged.CanFire` refuses a bow
      // swing at point-blank range (Chebyshev < 2). The bow's MaxRange
      // is the only valid range; at adjacency the bowman is meant to
      // draw a melee weapon. Was: adjacent enemies could be shot with
      // full DPS.
      if (weaponRange > 1 && Math.max(dx, dy) < 2) {
        if ((state._lastPointBlankMsg ?? 0) < now - 5000) {
          mob.client?.sendSystemMessage?.('You are too close to use that ranged weapon.');
          state._lastPointBlankMsg = now;
        }
        continue;
      }
      // Audit #36 P2 #14 — ServUO `BaseWeapon.OnSwing`/`CanFire` gates
      // every swing on `attacker.InLOS(defender)`. Was: a bowman could
      // shoot through a wall as long as the target was within 12
      // tiles; a swordsman could swing through a corner. Apply only
      // for ranged (weaponRange > 1) to keep melee permissive — at
      // adjacent range LOS is essentially guaranteed and the check
      // costs more than the bug fixes.
      if (weaponRange > 1) {
        try {
          if (!lineOfSight(mob.map, mob, target)) continue;
        } catch { /* LOS module optional */ }
      }
      // Ranged weapons require ammunition. Consume one arrow/bolt
      // from the wielder's pack; if none, abort the swing.
      if (weaponRange > 1) {
        // Archery draw delay — ServUO BaseRanged requires the wielder
        // to stand still for ~1 s after a move before the next shot
        // fires. The move handler stamps `_archeryDrawUntil`; reject
        // the swing while it's in the future, but DON'T tick
        // `nextSwingAt` so the shot fires the moment the draw ends.
        if ((mob._archeryDrawUntil ?? 0) > now) continue;
        const ammoId = mob._weapon.ammoId ?? 0x0F3F;   // arrow default
        let ammo = null;
        // Find arrows / bolts. ServUO BaseWeapon.OnSwing pulls ammo
        // from the wielder's backpack — NOT from worn equipment. Look
        // up the backpack via reverse index, then walk its children.
        // Bug-hunt #2 A7 — previously walked only mob's direct
        // children which misses everything inside the pack.
        const idx = world._childrenByParent;
        let packSerial = null;
        let quiver = null;
        if (idx) {
          const set = idx.get(mob.serial);
          if (set) {
            for (const s of set) {
              const it = world.items.get(s);
              if (!it) continue;
              if (it.layer === 21 && packSerial == null) packSerial = it.serial;
              // Audit #35 P3 #15 — ServUO `BaseRanged.OnSwing` consults
              // the cloak/quiver layer (22) BEFORE the backpack. A
              // worn quiver loaded with arrows was dead weight; loot
              // and dragged stacks went to the pack, but the combat
              // tick never read them.
              if (it.layer === 22 && (it.tagId === 'elven-quiver'
                                   || it.tagId === 'quiver-of-infinity')) {
                quiver = it;
              }
            }
          }
        } else {
          for (const it of world.items.values()) {
            if (it.parent !== mob.serial) continue;
            if (it.layer === 21 && packSerial == null) packSerial = it.serial;
            if (it.layer === 22 && (it.tagId === 'elven-quiver'
                                 || it.tagId === 'quiver-of-infinity')) {
              quiver = it;
            }
          }
        }
        // Quiver-first ammo pull. Walk its contents (immediate
        // children only — quivers don't nest).
        if (quiver) {
          const qset = idx?.get?.(quiver.serial);
          if (qset) {
            for (const s of qset) {
              const it = world.items.get(s);
              if (it?.itemId === ammoId && (it.amount | 0) > 0) { ammo = it; break; }
            }
          } else {
            for (const it of world.items.values()) {
              if (it.parent !== quiver.serial) continue;
              if (it.itemId === ammoId && (it.amount | 0) > 0) { ammo = it; break; }
            }
          }
        }
        if (!ammo && packSerial != null) {
          // Recurse — arrows often live in a sub-bag.
          for (const it of itemsMod.containerChildrenRecursive(world, packSerial)) {
            if (it.itemId !== ammoId) continue;
            if ((it.amount | 0) <= 0) continue;
            ammo = it; break;
          }
        }
        if (!ammo) {
          mob.client?.sendSystemMessage?.('You are out of ammunition.');
          state.combatant = 0;
          continue;
        }
        // Quiver of Infinity skips the decrement; ServUO models that
        // by routing the consume through the quiver, which returns
        // `false` for `ConsumeAmmo()`. Tag-based check here.
        const infinite = quiver?.tagId === 'quiver-of-infinity'
                      && ammo.parent === quiver.serial;
        if (!infinite) ammo.amount = (ammo.amount | 0) - 1;
        if (!infinite && ammo.amount <= 0) {
          // Use the full destroyItem path so the sectors index, the
          // ticking-items set + item-history all clean up. Bug-hunt
          // 2026-05-12 A9: prior `world.items.delete()` bypassed those
          // hooks — a scripted ammo (script:'arrow.onTick') stayed in
          // `world._tickingItems`, next tick `mobiles.get(serial)`
          // returned undefined and some scripts crashed.
          try { itemsMod.destroyItem(world, ammo.serial); }
          catch { /* item already gone */ }
        }
      }
      if ((state.nextSwingAt ?? 0) > now) continue;
      // BUGFIX #107 (FAZA FK): swings used to be free of stamina cost.
      // ServUO drains 1-3 stamina per swing. Without it, exhausted
      // players could swing indefinitely. Abort if below 3.
      if ((mob.stam ?? 0) < 3) {
        mob.client?.sendSystemMessage?.('You are too tired to swing.');
        continue;
      }
      mob.stam = Math.max(0, (mob.stam ?? 0) - 3);
      if (mob.client) {
        mob.client.send(staminaUpdate({
          serial: mob.serial, current: mob.stam, max: mob.stamMax ?? 50,
        }));
      }
      state.nextSwingAt = now + swingDelayMs(mob);
      // BUGFIX #128 (FAZA HN): every weapon swung the Attack1H frame
      // (0x09) — even bows. ServUO uses 0x12 (ShootBow) / 0x13
      // (ShootCrossbow). Pick the right animation from the wielded
      // weapon's range so observers see the proper draw-and-fire.
      const swingAnim = (() => {
        if (weaponRange > 1) {
          // Crossbows shoot bolts (0x1BFB); regular bows shoot arrows.
          return mob._weapon?.ammoId === 0x1BFB ? 0x13 : 0x12;
        }
        return 0x09; // melee
      })();
      this.animate(world, mob, swingAnim);
      // Play swing sound on everyone nearby. Sound 0x23B is ServUO's
      // unarmed/sword swing. Miss and hit below add their own variants.
      this.playSoundNear(world, mob, 0x23B);
      // Roll for hit/miss using primary weapon-skill diff. A miss still
      // costs the swing's cooldown so spammers can't bypass cadence.
      // Defender's effective combat skill (weapon or parry) is the
      // task difficulty for any skill-gain rolls below.
      const defWeapon = effectiveWeaponSkill(target);
      const defParry  = effectiveSkill(target, SKILL_PARRYING);
      const difficulty = Math.max(defWeapon, defParry, 1);
      if (Math.random() >= hitChance(mob, target)) {
        // Miss whoosh (0x239 in ServUO).
        this.playSoundNear(world, mob, 0x239);
        if (mob.client) mob.client.sendSystemMessage?.('You miss.');
        // Audit #35 P3 #17 — shield-block animation. ServUO
        // `Mobile.OnGotMeleeAttack` after a successful parry plays
        // `Animate(18 or 19, 7, 1, true, false, 0)` so observers see
        // the defender raise their shield. Was missing — purely
        // visual but expected by classic clients.
        if (target._hasShield) {
          const animId = Math.random() < 0.5 ? 0x12 : 0x13;
          try { this.animate(world, target, animId, { frameCount: 7, repeatCount: 1 }); }
          catch { /* animate optional */ }
        }
        const confidenceStam = applyConfidenceParryStamina(target);
        if (confidenceStam > 0 && target.client) {
          target.client.send(staminaUpdate({
            serial: target.serial,
            current: target.stam,
            max: target.stamMax ?? 50,
          }));
        }
        // Even a miss can teach you something — but only for the active
        // weapon skill, and at half the usual rate (we model that by
        // rolling once and discarding half the time).
        if (mob.skills && Math.random() < 0.5) {
          awardSkill(mob, primaryWeaponSkillId(mob), difficulty);
        }
        // Audit #39 P1 #6 — ServUO `Bushido/CounterAttack.cs` fires on
        // ANY successful parry (shield, Parrying skill, or Bushido)
        // within 1 tile. Was: gated to shield AND parry>weapon, so
        // ronin builds (Parrying without a shield) never countered.
        const cAttUntil = Number(target?.counterAttackUntil) || 0;
        if (cAttUntil > Date.now()) {
          target.counterAttackUntil = 0;
          const dx = Math.abs(target.x - mob.x);
          const dy = Math.abs(target.y - mob.y);
          if (Math.max(dx, dy) <= 1) {
            if (target.client) target.client.sendSystemMessage?.('You counter-attack!');
            this.animate(world, target, 0x09 /* OneHandedAttack */);
            this.playSoundNear(world, target, 0x23B);
            const counterDmg = rollDamage(target, mob);
            this.damage(world, mob, counterDmg, target);
          }
        }
        continue;
      }
      let dmg = rollDamage(mob, target);
      // AOS on-hit weapon-attribute procs — Splintering / HLD / HLA /
      // Velocity / DamageEater. Bonus damage from Velocity stacks
      // before the damage() call so the floating number / death-credit
      // ledger see the post-proc total.
      const procs = onHitProcs(mob, target, mob._weapon?.range ?? 1, dmg);
      if (procs.bonusDamage) dmg += procs.bonusDamage;
      if (procs.epiphany) {
        const packets = [
          healthUpdate({ serial: target.serial, current: target.hp ?? 0, max: target.hpMax ?? 50 }),
          manaUpdate({ serial: target.serial, current: target.mana ?? 0, max: target.manaMax ?? 50 }),
          staminaUpdate({ serial: target.serial, current: target.stam ?? 0, max: target.stamMax ?? 50 }),
        ];
        for (const pkt of packets) {
          if (target.client) target.client.send(pkt);
          for (const c of nearbyClients(world, target, target)) c.client.send(pkt);
        }
        target.client?.sendSystemMessage?.('Your Epiphany armor surges with power.');
      }
      // Audit #34 P2 #5 — Hit Dispel weapon proc. ServUO destroys the
      // summoned defender outright on a successful roll (e.g. Blade
      // Spirits / Energy Vortex). Use the canonical destroyMobile path
      // so reverse-index + sectors + party/aggressor pointers clean up.
      if (procs.dispelSummon && target.summoned) {
        try { world.destroyMobile?.(target.serial); }
        catch { /* already gone */ }
      }
      // Wrestling Disarm (0xBF 0x09) — dump defender's wielded weapon
      // into their backpack. ServUO `WrestlingDisarm.cs:OnHit`. Layer 1
      // = main hand, layer 2 = off-hand / shield; we drop both.
      if (procs.disarmDefender && target.equipment) {
        const pack = target.equipment.get?.(21);
        for (const layer of [1, 2]) {
          const worn = target.equipment.get?.(layer);
          if (worn && pack) {
            setItemParent(world, worn, pack.serial >>> 0);
            worn.layer = null;
            target.equipment.delete(layer);
          }
        }
      }
      // Wrestling Stun (0xBF 0x0A) — combat-formulas stamps
      // `_paralyzedUntil`; the movement queue + AI freeze checks read
      // it. Nothing more to do here except surface the action.
      if (procs.stunDefender && target.client) {
        try { target.client.send(unicodeMessage({
          text: 'You have been stunned!', hue: 0x35, font: 3, name: 'System',
        })); } catch { /* tolerate */ }
      }
      // Mastery passive trigger — Whispering Rose / Death Strike etc.
      // Lazy-loaded module ref (top-level import would cycle with the
      // mastery → combat-formulas chain). Async import on first hit.
      try {
        const masteriesMod = state.ctx?.systems?.skillMasteries;
        masteriesMod?.firePassive?.(mob, 'onHit', { defender: target, dmg });
      } catch { /* advisory */ }
      // BUGFIX #96 (FAZA EB): combat swings called damage() without the
      // attacker parameter, so the FAZA DM young-PK guard and FAZA DX
      // stealth-break-on-attack hook never fired during real combat —
      // they only ran for spell damage paths that happened to pass it.
      const appliedDamage = this.damage(world, target, dmg, mob) | 0;
      if (appliedDamage > 0) {
        world.events?.emit?.('combat:hit', {
          attacker: mob,
          source: mob,
          defender: target,
          target,
          amount: appliedDamage,
          damageType: target._lastDamageType ?? null,
          damageTypeName: target._lastDamageTypeName ?? null,
        });
      }
      // Durability decay (ServUO `BaseWeapon.OnHit` + `BaseArmor.OnHit`).
      // ~25% chance per hit to drop one durability point on the
      // attacker's weapon, plus ~25% on a random equipped armour piece
      // of the defender. When durability hits zero the item shatters
      // (destroyed) — mirrors AOS behaviour.
      this._decayDurability(world, mob, target);
      // Poisoned weapon (ServUO `BaseWeapon.OnHit` poison branch).
      // 50 % proc chance per hit; consumes one charge and applies a
      // status-effect tick of poison damage scaled by level. Empty
      // charges clear the poison so the wielder must re-apply.
      const wpnItem = world.items.get(mob._weaponSerial >>> 0);
      const statusEff = state.ctx?.statusEffects;
      if (wpnItem?.poison && (wpnItem.poison.charges | 0) > 0
          && Math.random() < 0.5 && statusEff?.apply) {
        const lvl = (wpnItem.poison.level | 0);
        wpnItem.poison.charges -= 1;
        if (wpnItem.poison.charges <= 0) wpnItem.poison = null;
        const tickDmg = 2 + lvl * 2;          // 2,4,6,8,10
        const ticks   = 6 + lvl * 2;          // 6,8,10,12,14
        statusEff.apply(target, {
          name: 'poison',
          durationMs: ticks * 1500,
          tickIntervalMs: 1500,
          data: { dmg: tickDmg, attacker: mob.serial },
          tick: (m) => { this.damage(world, m, tickDmg, mob); },
        });
      }
      // FAZA ED: Wraith Form mana-vamp. ServUO `Necromancy/WraithForm`
      // drains 5..15% of victim's mana to the attacker on every hit.
      const wraith = (mob.effects ?? []).find?.((e) => e?.name === 'wraith-form');
      if (wraith && (target.mana ?? 0) > 0) {
        const drain = Math.max(1, Math.min((target.mana | 0), Math.floor(dmg / 4)));
        target.mana -= drain;
        mob.mana = Math.min(mob.manaMax ?? 50, (mob.mana ?? 0) + drain);
        if (target.client) {
          target.client.send(manaUpdate({
            serial: target.serial, current: target.mana, max: target.manaMax ?? 50,
          }));
        }
        if (mob.client) {
          mob.client.send(manaUpdate({
            serial: mob.serial, current: mob.mana, max: mob.manaMax ?? 50,
          }));
        }
      }
      this.animate(world, target, 0x14 /* TakeHit */, { frameCount: 5 });
      // FAZA EB: parry skill gain when defender's parry was the active
      // defensive skill (and the defender survived the swing). The
      // gain only fires on hits (a miss already ran the weapon-skill
      // award above); attribution to parry mirrors ServUO's
      // `Mobile.OnHitParry`.
      if (target.skills && defParry > defWeapon) {
        awardSkill(target, SKILL_PARRYING, difficulty);
      }

      // FAZA CV: weapon special-ability queue. `state.queuedAbility`
      // is set by the [wpn command (and a future client packet); on
      // a successful hit we charge the mana cost and run the ability
      // handler which may apply bonus damage / debuff. Cleared whether
      // it fires or not so the player has to re-prime each swing —
      // mirrors ServUO's single-strike behaviour.
      if (state?.queuedAbility) {
        const slug = state.queuedAbility;
        state.queuedAbility = null;
        try {
          const wpnAbilities = state.ctx?.weaponAbilities;
          const def = wpnAbilities?.[slug];
          if (def) {
            const cost = def.mana | 0;
            if ((mob.mana ?? 0) >= cost) {
              mob.mana -= cost;
              if (mob.client && state.ctx?.protocol?.manaUpdate) {
                mob.client.send(state.ctx.protocol.manaUpdate({
                  serial: mob.serial, current: mob.mana,
                  max: mob.manaMax ?? 50,
                }));
              }
              const bonus = def.onHit?.({ mob, target, baseDamage: dmg, ctx: state.ctx }) ?? 0;
              if (bonus > 0) {
                const hp = healthUpdate({
                  serial: target.serial, current: target.hp ?? 0,
                  max: target.hpMax ?? 50,
                });
                if (target.client) target.client.send(hp);
                for (const c of nearbyClients(world, target)) c.client.send(hp);
              }
            } else if (mob.client) {
              mob.client.sendSystemMessage?.('You lack the mana for that ability.');
            }
          }
        } catch (e) {
          console.error('[wpn] ability handler threw:', e);
        }
      }

      // On-hit riders (FAZA AF) — read the buff/debuff plan, mutate the
      // attacker's HP for lifesteal and reflect-on-self for blood-oath,
      // then broadcast the resulting health updates.
      // BUGFIX #64 (FAZA CV): same fix as #55 in combat.damage —
      // healthUpdate must broadcast to nearby observers, not just the
      // affected mob. Without it overhead bars + dragged-out status
      // bars stayed stale on lifesteal / reflect HP swings.
      const riders = damageRiders(mob, target, dmg);
      if (riders.heal > 0) {
        const before = mob.hp ?? 0;
        mob.hp = Math.min(mob.hpMax ?? 50, before + riders.heal);
        if (mob.hp !== before) {
          const hp = healthUpdate({
            serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
          });
          if (mob.client) mob.client.send(hp);
          for (const c of nearbyClients(world, mob)) c.client.send(hp);
        }
      }
      if (riders.reflect > 0) {
        const before = mob.hp ?? 0;
        mob.hp = Math.max(0, before - riders.reflect);
        const dmgPkt = damagePacket({ serial: mob.serial, amount: riders.reflect });
        const hp = healthUpdate({
          serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
        });
        if (mob.client) { mob.client.send(dmgPkt); mob.client.send(hp); }
        for (const c of nearbyClients(world, mob)) {
          c.client.send(dmgPkt); c.client.send(hp);
        }
        // Bug-hunt #10 #1 — if reflect kills the attacker, run the
        // canonical death path. Previously a blood-oath kill produced a
        // HP=0 mob with no corpse, no notoriety, no kill credit.
        if (mob.hp <= 0 && before > 0) {
          try {
            state.ctx?.systems?.corpse?.killMobile?.(world, mob, target)
              ?? state.ctx?.corpse?.killMobile?.(world, mob, target);
          } catch (e) { console.error('[net] reflect-kill death failed:', e); }
        }
      }
      if (riders.manaLeech > 0) {
        // Hit Mana Leech — drain mana from defender, refund to attacker.
        // ServUO `BaseWeapon.OnHit` HitManaLeech roll: ~30 % of dealt
        // damage refunded, capped to defender's available mana.
        const drained = Math.min(target.mana | 0, riders.manaLeech);
        if (drained > 0) {
          target.mana = Math.max(0, (target.mana | 0) - drained);
          mob.mana = Math.min(mob.manaMax ?? 50, (mob.mana | 0) + drained);
          if (target.client) target.client.send(manaUpdate({
            serial: target.serial, current: target.mana, max: target.manaMax ?? 50,
          }));
          if (mob.client) mob.client.send(manaUpdate({
            serial: mob.serial, current: mob.mana, max: mob.manaMax ?? 50,
          }));
        }
      }
      // One-shot buffs (lightning-strike, ki-attack, focus-attack,
      // honorable-execution) consume after the swing — clearing them
      // here mirrors ServUO's "single-strike" abilities.
      for (const oneShot of ['lightning-strike','ki-attack','focus-attack','honorable-execution']) {
        if (mob.effects?.some?.((e) => e.name === oneShot)) {
          state.ctx?.statusEffects?.remove?.(mob, oneShot);
        }
      }
      // Hit-flesh thud — ServUO uses 0x135 for wrestling, 0x23C for swords.
      // Until we plumb weapon-type through the combat pipeline we go with
      // the wrestling variant (also the most common on low-level mobs).
      this.playSoundNear(world, target, 0x135);
      // Successful hit grants gain rolls on weapon skill, Tactics, and
      // Anatomy (the three that feed into damageMultiplier).
      if (mob.skills) {
        awardSkill(mob, primaryWeaponSkillId(mob), difficulty);
        awardSkill(mob, SKILL_TACTICS, difficulty);
        awardSkill(mob, SKILL_ANATOMY, difficulty);
      }
      // Defender practices Parrying just by being attacked successfully.
      if (target.skills) awardSkill(target, SKILL_PARRYING, effectiveWeaponSkill(mob));
      if ((target.hp ?? 0) <= 0) {
        state.combatant = 0;
        if (onKill) {
          // Pass the killer (the player whose state owned this swing) so
          // the kill-handler can run notoriety bookkeeping. Older handler
          // signatures that ignore the third arg keep working.
          try { onKill(world, target, mob); }
          catch (e) { console.error('[combat] onKill threw:', e); }
        }
      }
    }
  },
};

export function buildScriptCombatApi(defaultWorld, baseCombat = combat) {
  return {
    ...baseCombat,
    damage(...args) {
      if (isWorldLike(args[0])) return baseCombat.damage(...args);
      return baseCombat.damage(defaultWorld, ...args);
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt (0xC2) dispatch — free-form text response registry.
// ---------------------------------------------------------------------------

/** @typedef {(reply: {cancelled:boolean, text:string}) => void} PromptCallback */

function handlePromptReply(state, pkt) {
  let parsed;
  try { parsed = readUnicodePromptReply(pkt); }
  catch { return; }
  const cb = state.activePrompts?.get(parsed.promptId);
  if (!cb) return;
  state.activePrompts.delete(parsed.promptId);
  try { cb({ cancelled: parsed.cancelled, text: parsed.text }); }
  catch (e) { console.error('[prompt] callback threw:', e); }
}

export const prompts = {
  /**
   * Ask the client for a string. Returns the prompt id used.
   *
   * @param {import('./net-state.js').NetState} state
   * @param {{text?:string}} opts
   * @param {PromptCallback} cb
   */
  ask(state, opts, cb) {
    if (!state.activePrompts) state.activePrompts = new Map();
    const promptId = (state._nextPromptId = (state._nextPromptId ?? 1) + 1);
    state.activePrompts.set(promptId, cb);
    state.send(unicodePrompt({
      serial: state.mobile?.serial ?? 0,
      promptId,
      text: opts.text ?? '',
    }));
    return promptId;
  },
};

// ---------------------------------------------------------------------------
// Party dispatch — routes 0xBF subcmd 0x06 through `state.ctx.partyRegistry`.
// ---------------------------------------------------------------------------

function handlePartyCommand(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const registry = state.ctx.partyRegistry;
  if (!registry) return;
  const me = state.mobile.serial;
  let cmd;
  try { cmd = readPartyCommand(pkt); }
  catch { return; }
  switch (cmd.kind) {
    case 'add':
      if (cmd.target) {
        registry.invite(me, cmd.target);
      } else {
        targeting.request(state, (picked) => {
          const target = picked?.serial ? state.ctx.world.mobiles.get(picked.serial >>> 0) : null;
          if (!target?.client || target.serial === me) {
            state.sendSystemMessage?.('Select a player to invite.');
            return;
          }
          registry.invite(me, target.serial);
        }, { kind: 0 });
      }
      return;
    case 'remove':
      if (cmd.target === me) registry.leave(me);
      else if (registry.partyOf(me)?.leader === me) registry.leave(cmd.target);
      return;
    case 'accept':  registry.accept(me, cmd.leader); return;
    case 'decline': registry.decline(me, cmd.leader); return;
    case 'canLoot':
      if (registry.setCanLoot(me, cmd.canLoot)) {
        state.sendSystemMessage?.(cmd.canLoot
          ? 'You have chosen to allow your party to loot your corpse.'
          : 'You have chosen to prevent your party from looting your corpse.');
      } else {
        state.sendSystemMessage?.('You are not in a party.');
      }
      return;
    case 'tellAll': registry.tellAll(me, cmd.text); return;
    case 'tell':    registry.tellOne(me, cmd.target, cmd.text); return;
  }
}

// ---------------------------------------------------------------------------
// Guild chat — 0xBF subcmd 0x28 (plain ASCII message from client).
// ---------------------------------------------------------------------------

function handleGuildMessage(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  const reg = state.ctx.guildRegistry;
  if (!reg) return;
  let text;
  try { text = readGuildMessage(pkt).text; }
  catch { return; }
  if (!text) return;
  reg.chat(state.mobile.serial, text);
}

// ---------------------------------------------------------------------------
// Secure trade — 0x6F. We only implement close + accept/check; opening a
// trade is driven by scripts through `trade.open(...)`.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TradeSession
 * @property {number} containerA
 * @property {number} containerB
 * @property {import('./net-state.js').NetState} a
 * @property {import('./net-state.js').NetState} b
 * @property {boolean} acceptedA
 * @property {boolean} acceptedB
 */

/** @type {Map<number, TradeSession>} */
const tradeByContainer = new Map();

function handleTradeCommand(state, pkt) {
  let cmd;
  try { cmd = readTradeCommand(pkt); }
  catch { return; }
  const session = tradeByContainer.get(cmd.containerSerial);
  if (!session) return;
  // BUGFIX #52 (FAZA CJ): the previous handler routed `close` straight
  // through without checking that `state` is one of the trade
  // participants. A third party that learned the container serial
  // (e.g. via packet sniff or a leaked debug print) could spam close
  // packets and cancel any trade in progress. Same applies to `check`,
  // which already had the participant guard inline but silently
  // ignored stranger checks rather than rejecting them — stricter and
  // observable here. Bouncing on stranger commands also makes server
  // logs surface the abuse.
  if (state !== session.a && state !== session.b) return;
  if (cmd.kind === 'close') {
    trade.cancel(session);
    return;
  }
  if (cmd.kind === 'check') {
    if (state === session.a) session.acceptedA = cmd.first;
    else if (state === session.b) session.acceptedB = cmd.first;
    const bytesA = tradeCheck({ containerSerial: session.containerA, first: session.acceptedA, second: session.acceptedB });
    const bytesB = tradeCheck({ containerSerial: session.containerB, first: session.acceptedB, second: session.acceptedA });
    session.a.send(bytesA); session.b.send(bytesB);
    if (session.acceptedA && session.acceptedB) trade.commit(session);
  }
}

export const trade = {
  // Exposed for net-state.js's _onClose disconnect cleanup so it can
  // enumerate active sessions without importing the module-level
  // tradeByContainer map (which would cycle the dependency graph).
  _byContainer: tradeByContainer,
  /**
   * Open a trade session between two NetStates.
   * @param {import('./net-state.js').NetState} a
   * @param {import('./net-state.js').NetState} b
   */
  open(a, b) {
    if (!a.mobile || !b.mobile) return null;
    const world = a.ctx.world;
    const containerA = world.serial.allocItem();
    const containerB = world.serial.allocItem();
    const session = {
      containerA, containerB, a, b,
      acceptedA: false, acceptedB: false,
      itemsA: new Set(), itemsB: new Set(),
    };
    tradeByContainer.set(containerA, session);
    tradeByContainer.set(containerB, session);
    // Both sides may drop into / pick up from either window.
    a.openContainers.add(containerA);
    a.openContainers.add(containerB);
    b.openContainers.add(containerA);
    b.openContainers.add(containerB);
    a.send(tradeOpen({
      containerSerial: containerA, otherSerial: b.mobile.serial,
      ourSerial: a.mobile.serial, partnerName: b.mobile.name,
    }));
    b.send(tradeOpen({
      containerSerial: containerB, otherSerial: a.mobile.serial,
      ourSerial: b.mobile.serial, partnerName: a.mobile.name,
    }));
    // BUGFIX #57 (FAZA CO): the trade containers are virtual (no entry
    // in world.items) so the existing container-ui visualisation never
    // tracked them. Items dropped via handleTradeDrop got reparented
    // and the 0x25 update was sent — but with no `_ensureWindow` ever
    // called, both clients silently dropped the update. Result: items
    // moved through the data model invisibly, leaving the user staring
    // at "You: ✓ Them: ✓" with no way to see what's being traded.
    //
    // Open BOTH containers (0x24 displayContainer + 0x3C empty contents)
    // on BOTH participants so each side sees their own offer AND their
    // partner's offer side-by-side via the standard container-ui.
    // gumpId 0x66 is the canon UO secure-trade gump — registered as a
    // 5×4 grid in CONTAINER_PRESETS.
    const TRADE_GUMP = 0x66;
    a.send(displayContainer(containerA, TRADE_GUMP));
    a.send(containerContents(containerA, []));
    a.send(displayContainer(containerB, TRADE_GUMP));
    a.send(containerContents(containerB, []));
    b.send(displayContainer(containerA, TRADE_GUMP));
    b.send(containerContents(containerA, []));
    b.send(displayContainer(containerB, TRADE_GUMP));
    b.send(containerContents(containerB, []));
    return session;
  },
  cancel(session) {
    tradeByContainer.delete(session.containerA);
    tradeByContainer.delete(session.containerB);
    for (const s of [session.a, session.b]) {
      s.openContainers.delete(session.containerA);
      s.openContainers.delete(session.containerB);
    }
    // Return each side's items to its owner's inventory (parent = mobile).
    returnTradeItems(session.a, session.itemsA);
    returnTradeItems(session.b, session.itemsB);
    session.a.send(tradeClose(session.containerA));
    session.b.send(tradeClose(session.containerB));
  },
  commit(session) {
    // Swap: A's items go to B; B's items go to A.
    const world = session.a.ctx.world;
    transferTradeItems(world, session.itemsA, session.b);
    transferTradeItems(world, session.itemsB, session.a);
    tradeByContainer.delete(session.containerA);
    tradeByContainer.delete(session.containerB);
    for (const s of [session.a, session.b]) {
      s.openContainers.delete(session.containerA);
      s.openContainers.delete(session.containerB);
    }
    session.a.send(tradeClose(session.containerA));
    session.b.send(tradeClose(session.containerB));
    session.a.sendSystemMessage?.('Trade complete.');
    session.b.sendSystemMessage?.('Trade complete.');
  },
};

/**
 * Handle an 0x08 drop whose target container is a trade window. Enforces
 * that the sender only drops into *their* side, reparents the item to the
 * virtual container, resets accept flags, and notifies both participants.
 */
function handleTradeDrop(state, item, session, container, x, y, gridLocation) {
  const isA = state === session.a;
  const isB = state === session.b;
  const ownContainer = isA ? session.containerA : isB ? session.containerB : null;
  // Only allow dropping into your own side.
  if (!ownContainer || ownContainer !== container) {
    state.send(dropAck(false));
    bounceHeldToFeet(state, item);
    return;
  }
  setItemParent(state.ctx.world, item, container);  // A5
  item.layer = 0;
  item.gridX = x & 0xffff;
  item.gridY = y & 0xffff;
  item.gridLocation = gridLocation;
  item.map = 0;
  state.heldItem = null;
  (isA ? session.itemsA : session.itemsB).add(item.serial);
  state.send(dropAck(true));
  const entry = {
    serial: item.serial, itemId: item.itemId, amount: item.amount,
    gridX: item.gridX, gridY: item.gridY, gridLocation: item.gridLocation,
    hue: item.hue,
  };
  // Both sides see the item in the sender's window.
  session.a.send(containerContentUpdate(entry, container));
  session.b.send(containerContentUpdate(entry, container));
  // Gold side — compute current gold offered on each side and ship a
  // status line. ServUO renders this as a dedicated counter inside the
  // SecureTradeContainer gump; our client doesn't have the gump asset
  // yet, so a system message keeps both participants informed without
  // opening a second packet path. Drop into either side recomputes
  // both totals because reset-on-edit (resetTradeAccept) already
  // forces both viewers to re-confirm.
  resetTradeAccept(session);
  broadcastTradeGoldStatus(session, state.ctx?.world);
}

/** Sum gold piles currently staged on each trade side and notify both
 *  participants. Called whenever items change. Cheap O(|stagedItems|). */
function broadcastTradeGoldStatus(session, world) {
  if (!world?.items) return;
  const sumSide = (set) => {
    let g = 0;
    for (const serial of set) {
      const it = world.items.get(serial);
      if (!it) continue;
      if (it.itemId !== 0x0EED) continue;        // gold piles only
      g += it.amount | 0;
    }
    return g;
  };
  const goldA = sumSide(session.itemsA);
  const goldB = sumSide(session.itemsB);
  const aName = session.a.mobile?.name ?? '?';
  const bName = session.b.mobile?.name ?? '?';
  const line = `Trade gold — ${aName}: ${goldA} gp · ${bName}: ${goldB} gp`;
  session.a.sendSystemMessage?.(line);
  session.b.sendSystemMessage?.(line);
}

/** Send a reset tradeCheck to both sides and clear session accept flags. */
function resetTradeAccept(session) {
  if (!session.acceptedA && !session.acceptedB) return;
  session.acceptedA = false;
  session.acceptedB = false;
  session.a.send(tradeCheck({ containerSerial: session.containerA, first: false, second: false }));
  session.b.send(tradeCheck({ containerSerial: session.containerB, first: false, second: false }));
}

/** Find an existing trade session between two NetStates, regardless of
 *  which side opened it. Used by handleDrop's drop-on-player branch to
 *  avoid stacking duplicate sessions when the same player drops a
 *  second item before the first trade was committed/cancelled. */
function findTradeSession(stateA, stateB) {
  // Sessions are indexed twice in tradeByContainer (containerA + containerB
  // both point at the same session); deduplicate via a Set.
  const seen = new Set();
  for (const session of tradeByContainer.values()) {
    if (seen.has(session)) continue;
    seen.add(session);
    if ((session.a === stateA && session.b === stateB) ||
        (session.a === stateB && session.b === stateA)) {
      return session;
    }
  }
  return null;
}

/** Drop the currently held item at the player's feet (used on trade errors). */
function bounceHeldToFeet(state, item) {
  setItemParent(state.ctx.world, item, null);
  item.x = state.mobile.x; item.y = state.mobile.y; item.z = state.mobile.z;
  item.map = state.mobile.map;
  state.heldItem = null;
  state.send(worldItemSA({
    serial: item.serial, itemId: item.itemId, amount: item.amount,
    x: item.x, y: item.y, z: item.z, hue: item.hue,
    flags: (item.movable ?? true) ? 0x20 : 0x00,
  }));
}

/**
 * Resolve the backpack container (layer 21) for a mobile. Returns the item
 * or null if the mobile has no backpack. Items without a backpack have
 * nowhere to land from a trade.
 */
function backpackOf(world, mob) {
  if (!mob) return null;
  // Fast path — cached serial. Stamped on first lookup, invalidated
  // implicitly when `world.items.get` returns undefined (pack destroyed
  // or detached). Bug-hunt #2 B3.
  const cachedSerial = mob._packSerial | 0;
  if (cachedSerial) {
    const cached = world.items.get(cachedSerial);
    if (cached && cached.parent === mob.serial && cached.layer === 21) return cached;
    mob._packSerial = 0;
  }
  // Reverse parent index walks only worn slots (~10 items).
  const idx = world._childrenByParent?.get?.(mob.serial);
  if (idx) {
    for (const s of idx) {
      const it = world.items.get(s);
      if (it?.parent === mob.serial && it.layer === 21) {
        mob._packSerial = it.serial;
        return it;
      }
    }
    return null;
  }
  for (const it of world.items.values()) {
    if (it.parent === mob.serial && it.layer === 21) {
      mob._packSerial = it.serial;
      return it;
    }
  }
  return null;
}

/** Reparent leftover trade items back into their owner's backpack. */
function returnTradeItems(state, serials) {
  const world = state.ctx.world;
  const bp = backpackOf(world, state.mobile);
  for (const s of serials) {
    const it = world.items.get(s);
    if (!it) continue;
    setItemParent(world, it, bp ? bp.serial : state.mobile.serial);
    it.layer = 0;
    it.gridX = 0; it.gridY = 0; it.gridLocation = 0;
  }
  serials.clear();
}

/** Move a source set of items into the receiver's backpack. */
function transferTradeItems(world, serials, receiver) {
  const bp = backpackOf(world, receiver.mobile);
  for (const s of serials) {
    const it = world.items.get(s);
    if (!it) continue;
    setItemParent(world, it, bp ? bp.serial : receiver.mobile.serial);
    it.layer = 0;
    it.gridX = 0; it.gridY = 0; it.gridLocation = 0;
  }
  serials.clear();
}

// ---------------------------------------------------------------------------
// Help request — 0x9B. 258 bytes of mostly-zero payload from the client.
// ---------------------------------------------------------------------------

function handleBulletinBoardReq(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  try { handleBulletinPacket(state, pkt); }
  catch (e) { console.error('[bbs]', e.message); }
}

/**
 * `/channel msg`, `/list`, `/join`, `/leave` chat-channel UX. Returns
 * true when the input was consumed (so the caller skips the world
 * speech broadcast), false to fall through.
 */
function handleChannelCommand(state, mob, text) {
  // Strip leading slash + tokenise. Empty / single-char inputs fall
  // through (caller broadcasts them as speech, e.g. someone literally
  // saying "/").
  const body = text.slice(1).trim();
  if (!body) return false;
  const m = body.match(/^(\S+)\s*(.*)$/);
  if (!m) return false;
  const verb = m[1].toLowerCase();
  const rest = m[2];

  if (verb === 'list' || verb === 'channels') {
    const lines = chatChannels.list().map((c) => `  ${c.name} (${c.members})`);
    state.sendSystemMessage?.(`Channels:\n${lines.join('\n')}`);
    return true;
  }
  if (verb === 'join' && rest) {
    if (chatChannels.join(rest, mob)) state.sendSystemMessage?.(`Joined ${rest}.`);
    else state.sendSystemMessage?.(`Cannot join ${rest}.`);
    return true;
  }
  if (verb === 'leave' && rest) {
    if (chatChannels.leave(rest, mob)) state.sendSystemMessage?.(`Left ${rest}.`);
    else state.sendSystemMessage?.(`You are not in ${rest}.`);
    return true;
  }

  // Otherwise treat the verb as a channel name and `rest` as the
  // message. Auto-join if not yet a member so first-time `/general hi`
  // just works.
  if (rest) {
    if (!chatChannels.isMember(verb, mob)) chatChannels.join(verb, mob);
    const count = chatChannels.broadcast(verb, mob, () => unicodeMessage({
      serial: mob.serial,
      graphic: mob.body,
      type: 0,
      hue: 0x0481,            // chat channel hue (CUO ChatColor.Default)
      name: `[${verb}] ${mob.name}`,
      text: rest,
    }));
    if (count === 0 && !chatChannels.isMember(verb, mob)) {
      state.sendSystemMessage?.(`Channel "${verb}" does not exist.`);
    } else {
      // Echo to self so the sender sees their own line.
      state.send(unicodeMessage({
        serial: mob.serial, graphic: mob.body, type: 0, hue: 0x0481,
        name: `[${verb}] ${mob.name}`, text: rest,
      }));
    }
    return true;
  }
  return false;
}

function handleHelpRequest(state, pkt) {
  // 0x9B HelpRequest layout in ServUO PageQueueGump dispatch is just a
  // stub trigger — the C# server pops a category gump back to the
  // client. We don't have that gump wired client-side yet, so the
  // simplest port is "treat the 257-byte payload as a category byte +
  // 256-char message slot, then enqueue". Older clients send only the
  // opcode + 1B, so we fall back to category=Other / no message.
  let category = 8;        // 'Other request'
  let text = '';
  if (pkt && pkt.length >= 2) {
    try {
      const r = readHelpRequest(pkt);
      if (r) { category = r.category ?? category; text = r.text ?? ''; }
    } catch { /* shape-tolerant — older clients omit fields */ }
  }
  if (!text) text = `(no message — category ${helpQueue.categoryName(category)})`;
  const id = helpQueue.enqueue({
    sender: state.mobile?.name ?? state.accountName ?? '(anon)',
    senderSerial: state.mobile?.serial ?? 0,
    text, category,
  });
  console.log(`[help#${id}] ${state.mobile?.name ?? '(anon)'} (${helpQueue.categoryName(category)}): ${text}`);
  // Open the Help category gump server-side so clients without the
  // built-in help dialog still get an interactive picker. ServUO uses
  // QueryHelpGump (subop 0xBF/0x39); we use the standard 0xB0 layout.
  try {
    const gumpDispatcher = state.ctx?.systems?.serverGumps;
    const gumps = state.ctx?.gumps;
    if (gumpDispatcher?.openHelpCategoriesGump && gumps?.send) {
      gumpDispatcher.openHelpCategoriesGump(gumps, state, (chosenCategory) => {
        if (chosenCategory != null && chosenCategory !== category) {
          // Player picked a different category → record an updated entry.
          helpQueue.enqueue({
            sender: state.mobile?.name ?? state.accountName ?? '(anon)',
            senderSerial: state.mobile?.serial ?? 0,
            text: `(category reclassified to ${helpQueue.categoryName?.(chosenCategory) ?? chosenCategory})`,
            category: chosenCategory,
          });
        }
      });
    }
  } catch { /* gump optional */ }
  state.sendSystemMessage?.(`Your page (#${id}) has been entered into the help queue. A GM will be with you shortly.`);
  // Notify staff online — visibility filter to GM/Admin only.
  for (const o of state.ctx.world.mobiles.values()) {
    if (!o.client) continue;
    const lvl = o.client.account?.accessLevel;
    if (lvl !== 'GM' && lvl !== 'Admin') continue;
    o.client.sendSystemMessage?.(`[help#${id}] ${state.mobile?.name ?? '(anon)'}: ${text}`, 0x40);
  }
}

// ---------------------------------------------------------------------------
// Object properties / tooltips — 0xD6.
//
// The client sends 0xD6 with a list of serials it wants property-lists for.
// We look them up via `state.ctx.propertyProvider(serial)` which returns
// `{entries, hash}`. Providers hang off sharedCtx; scripts register them.
// ---------------------------------------------------------------------------

/** @typedef {(serial:number, state:import('./net-state.js').NetState)=>({entries:Array<{cliloc:number,args?:string}>, hash?:number}|null)} PropertyProvider */

function handleOPLRequest(state, pkt) {
  if (!state.ctx.propertyProvider) return;
  let req;
  try { req = readOPLRequest(pkt); }
  catch { return; }
  for (const serial of req.serials) {
    const result = state.ctx.propertyProvider(serial, state);
    if (!result) continue;
    const hash = result.hash ?? computeOPLHash(result.entries);
    state.send(objectProperties({ serial, hash, entries: result.entries }));
  }
}

export const properties = {
  /**
   * Register a global provider that maps `serial → {entries, hash?}`.
   * @param {Object} ctx  sharedCtx
   * @param {PropertyProvider} fn
   */
  setProvider(ctx, fn) { ctx.propertyProvider = fn; },

  /** Send an OPLInfo hash nudge to one client. */
  nudge(state, serial, hash) { state.send(oplInfo(serial, hash)); },

  /** Send a full 0xD6 packet to one client. */
  send(state, serial, entries) {
    const hash = computeOPLHash(entries);
    state.send(objectProperties({ serial, hash, entries }));
  },

  computeHash: computeOPLHash,
};

// ---------------------------------------------------------------------------
// 0x95 HuePickerResponse — fixed 9B (op + dialogId u32 + itemId u16 + hue u16)
//
// Client picks a hue from a hue-picker dialog the server pushed via outbound
// 0x95. We look up the pending picker by `dialogId`, validate ownership, and
// invoke its callback. Dialogs that go unanswered for >60s are pruned in
// `cleanupHuePickers`.
// ---------------------------------------------------------------------------

function handleHuePickerResponse(state, pkt) {
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

function handleMobileNameRequest(state, pkt) {
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

function handleAsciiPromptResponse(state, pkt) {
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

function handleGMSingle(state /* , pkt */) {
  if (state.stage !== Stage.InWorld || !state.mobile?.isAdmin) return;
  // Body is documented as a packed (CommandType, args) blob with no fixed
  // schema across client builds. Ignore the payload — admins use [commands.
}

// ---------------------------------------------------------------------------
// 0xB6 ObjectHelpRequest — fixed 9B (op + serial + reqType).
// Older clients ask for "help" text on right-click; modern flow uses 0xD6.
// We respond with a 0xB7 ObjectHelpResponse pointing to a generic message.
// ---------------------------------------------------------------------------

function handleObjectHelpRequest(state, pkt) {
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

function handleClientViewRange(state, pkt) {
  if (state.stage !== Stage.InWorld) return;
  const range = pkt[1] | 0;
  state.viewRange = Math.max(5, Math.min(18, range || 18));
}

// ---------------------------------------------------------------------------
// 0xEC EquipMacro / 0xED UnequipMacro — variable. Player triggered an
// in-game macro to equip/unequip from the paperdoll. ServUO simply forwards
// to the wear/unwear pipeline.
// ---------------------------------------------------------------------------

function handleEquipMacro(state, pkt) {
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

function handleUnequipMacro(state, pkt) {
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
          c.send(removeEntity(item.serial));
        }
        state.send(containerContents([item], { containerSerial: backpack.serial }));
      } catch { /* ignore broadcast errors */ }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Graphical effects.
// ---------------------------------------------------------------------------

export const effects = {
  EffectKind,
  /**
   * Play a graphical effect at `mob`'s position, broadcast to every nearby
   * client.
   */
  playAt(world, origin, { itemId, hue = 0, kind = EffectKind.Stationary, speed = 5, duration = 10, renderMode = 0 }) {
    const usesHue = hue !== 0 || renderMode !== 0;
    const build = usesHue ? huedEffect : graphicalEffect;
    const bytes = build({
      kind, from: origin.serial ?? 0, to: origin.serial ?? 0,
      itemId,
      fromX: origin.x, fromY: origin.y, fromZ: origin.z,
      toX: origin.x, toY: origin.y, toZ: origin.z,
      speed, duration,
      hue, renderMode,
    });
    for (const m of world.mobiles.values()) {
      if (!m.client) continue;
      if (Math.abs(m.x - origin.x) > 24) continue;
      if (Math.abs(m.y - origin.y) > 24) continue;
      m.client.send(bytes);
    }
  },

  /** Send a single effect packet to one client. */
  send(state, params) {
    const usesHue = params.hue !== undefined || params.renderMode !== undefined;
    state.send((usesHue ? huedEffect : graphicalEffect)(params));
  },
};

// ---------------------------------------------------------------------------
// Quest arrow helper.
// ---------------------------------------------------------------------------

export const quest = {
  /** Show / move the quest arrow for one client. */
  show(state, x, y, serial) { state.send(questArrow({ active: true, x, y, serial })); },
  hide(state) { state.send(questArrow({ active: false, x: 0, y: 0 })); },
};

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
// We resolve the player's house via `state.ctx.systems.houses.housesOf(serial)[0]`
// — multi-house players need a target picker, MVP picks the first.
// ---------------------------------------------------------------------------

function handleHouseCustomization(state, pkt) {
  if (state.stage !== Stage.InWorld || !state.mobile) return;
  if (pkt.length < 9) return;
  const r = new PacketReader(pkt);
  r.readU8();
  r.readU16();         // length
  r.readU32();         // ownerSerial — clients echo their own serial here
  const sub = r.readU16();

  const houseRegistry = state.ctx.houses ?? state.ctx.systems?.houses;
  if (!houseRegistry) return;
  const houses = houseRegistry.housesOf?.(state.mobile.serial) ?? [];
  const house = houses[0] ?? null;
  if (!house) {
    state.sendSystemMessage?.('You do not own a house to customize.');
    return;
  }

  const ack = (msg) => state.sendSystemMessage?.(msg);

  // Subop body parsers — ServUO/CUO writes u8 0x00 separators before
  // each u32 to avoid reading into framing slop.
  const readSepU32 = () => { r.readU8(); return r.readU32() | 0; };
  const readSepI32 = () => { r.readU8(); return r.readI32(); };

  switch (sub) {
    case 0x02:
      houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.backupCustom?.(house);
      ack('House layout backed up.');
      break;
    case 0x03:
      if (houseRegistry.restoreCustom?.(house)) ack('House layout restored from backup.');
      else ack('No backup to restore.');
      break;
    case 0x04:
      if (houseRegistry.commitCustom?.(house)) ack(`House layout committed (${house.tiles?.length ?? 0} tiles).`);
      else ack('Not in edit mode.');
      break;
    case 0x05: {
      const g = readSepU32();
      const x = readSepU32();
      const y = readSepU32();
      const z = readSepI32();
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      const removed = houseRegistry.removeCustomItem?.(house, g, x, y, z) ?? 0;
      if (!removed) ack('No matching tile to remove.');
      break;
    }
    case 0x06: {
      const g = readSepU32();
      const x = readSepU32();
      const y = readSepU32();
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.addCustomItem?.(house, 'item', g, x, y, 0);
      break;
    }
    case 0x0C:
      if (houseRegistry.revertCustom?.(house)) ack('Exited customization without saving.');
      break;
    case 0x0D: {
      const g = readSepU32();
      const x = readSepU32();
      const y = readSepU32();
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.addCustomItem?.(house, 'stair', g, x, y, 0);
      break;
    }
    case 0x0E:
      ack(`Sync — revision ${house.revision ?? 0}, tiles ${house.tiles?.length ?? 0}.`);
      break;
    case 0x10:
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.clearCustomTiles?.(house);
      ack('Cleared editing buffer.');
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
      const x = readSepU32();
      const y = readSepU32();
      const z = readSepI32();
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.addCustomItem?.(house, 'roof', g, x, y, z);
      break;
    }
    case 0x14: {
      const g = readSepU32();
      const x = readSepU32();
      const y = readSepU32();
      const z = readSepI32();
      if (!house.editing) houseRegistry.beginEditing?.(house, state.mobile);
      houseRegistry.removeCustomItem?.(house, g, x, y, z);
      break;
    }
    case 0x1A:
      if (houseRegistry.revertCustom?.(house)) ack('Reverted edits.');
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
      const active = ml?.listActive?.(state.mobile?.serial) ?? [];
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
function handleKrriosRequest(state) {
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

// ---- Bank box helpers ------------------------------------------------------
// Walk an item's parent chain up to 8 hops. Returns the bank container
// (layer 0x1D) if one is in the chain, else null. Used to enforce the
// 125-item / 1600-stone cap on bank deposits.
function _findBankRoot(world, item) {
  let cur = item;
  for (let hop = 0; hop < 8; hop++) {
    if (!cur) return null;
    if (cur.layer === 0x1D) return cur;
    const p = world.items.get(cur.parent);
    if (!p) return null;
    cur = p;
  }
  return null;
}
function _isInsideBank(world, item) {
  return _findBankRoot(world, item) !== null;
}
