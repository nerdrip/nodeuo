// Decode server opcodes, mutate the world mirror and publish UI events.
import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';
import {
  decodeClientTalk,
  decodeLoginRejection, decodeConnectionError, decodeServerList,
  decodePlayServerAck, decodeCharacterList, decodeLoginConfirm,
  decodeLoginComplete, decodeMobileMoving, decodeMobileIncoming,
  decodeMobileUpdate, decodeExtendedCommand, decodeContextMenu, decodePlayMusic,
  decodeMovementRej, decodeMovementAck, decodePing, decodeAsciiMessage,
  decodeUnicodeMessage, decodeOverallLight, decodeSeason, decodeWeather,
  decodeSupportedFeatures, decodeAttributeUpdate,
  decodeOpenGump, decodeCompressedGump,
  decodeOpenPaperdoll, decodeOpenContainer, decodeContainerContents,
  decodeContainerContentUpdate, decodeSkills, decodeBuyList, decodeSellList,
  decodeTargetCursor, decodeClilocMessage, decodePlaySound,
  decodeCharacterAnimation, decodeNewCharacterAnimation,
  decodeWorldItem, decodeWorldItemSA,
  decodeMegaCliloc, decodeOPLInfo, decodeWarMode,
  decodeGraphicEffect, decodeGraphicEffectHued, decodeGraphicEffectExt, decodeDamage,
  decodeMultiPlacement,
  decodeNewMapMessage, decodeKrrios,
  decodeMobileAttributes, decodeEquipUpdate, decodeSwing,
  decodeMovePlayer, decodeTextEntryDialog, decodeDeathAction,
  decodeCharacterProfile, decodeQuestArrow, decodeUnicodePrompt,
  decodeGoldReward, decodeSemivisible, decodeUpdateObject,
  decodeCharMoveAnim, decodeBuffDebuff, decodeBoatMoving,
  decodePersonalLight, decodeCustomHouse, decodeOpenBook, decodeOpenBookLegacy,
  decodeMobileStatus, decodeNewHealthbarUpdate, decodeDeathStatus,
  decodeSecureTrade, decodeAttackReply, decodeLogoutResponse,
  decodeCorpseEquipment, decodeAllNames, decodeDyeData, decodeClilocAffix,
  decodeDragAnimation, decodeOpenMenu, decodeWaypoint,
} from './incoming.js';
import {
  buildAsciiSpeechAck,
  buildClientType,
  buildClientVersion,
  buildHuePickerResponse,
  buildResyncRequest,
  buildSkillsRequest,
  buildUseReq,
  buildWarMode,
} from './outgoing.js';
import { corpseManager } from '../managers/corpse-manager.js';
import { walker } from '../managers/walker.js';
import { profile } from '../managers/profile-manager.js';
import { DIR_DX, DIR_DY, DIR_MASK, DIR_RUNNING_BIT, directionFromDelta } from '../shared/directions.js';
import { isDeadBody } from '../shared/bodies.js';
import { applyWorldItemInfo, captureNameFromSingleClick, u16, u32 } from './packet-state.js';
import { resetNodeUOModernState } from './nodeuo-modern.js';
import { assets } from '../assets/asset-manager.js';

/** ServUO answers 0x09 LookReq with a 0x1C/0xAE speech packet whose
 *  `name` header is "You see" and whose `text` is the target's display
 *  name. Capture it so the overhead label stops showing the raw serial
 *  the moment the server replies — without it the label only updates
 *  when the user opens the paperdoll (0x88 carries the name too). */

/** Authoritative client-side cache of the local player's war state.
 *  Updated on every 0x72 echo + consulted by `_applySelfWarLatch` to
 *  re-affirm the war bit after any 0x77/0x78/0x20 handler applies
 *  incoming fields (which would otherwise overwrite the just-
 *  toggled state with a stale incoming flags byte). 5-second guard
 *  window — long enough to cover network jitter, short enough that a
 *  legitimate server-side war flip (death, gump action) takes effect
 *  on the next mobileIncoming. */
let _selfWarLatch = { warMode: null, at: 0 };
const SELF_WAR_LATCH_MS = 5000;

/** Pin the latest known/intended war state. Called from the 0x72 handler
 *  AND from optimistic local toggles (paperdoll button / Tab macro) so
 *  a stale 0x77/0x78 self-echo arriving in the toggle's wake can't undo
 *  the just-flipped bit. */
export function pinSelfWarLatch(warMode) {
  _selfWarLatch = { warMode: !!warMode, at: performance.now() };
}

function _applySelfWarLatch(m) {
  if (!world.player || m !== world.player) return;
  if (_selfWarLatch.warMode == null) return;
  if (performance.now() - _selfWarLatch.at > SELF_WAR_LATCH_MS) return;
  const bit = 0x40;
  const want = _selfWarLatch.warMode ? ((m._flags | 0) | bit) : ((m._flags | 0) & ~bit);
  if (want !== m._flags) m.flags = want;     // re-derive booleans via setter
}

function _applyMobilePacketFields(m, info) {
  m.body = info.body;
  m.hue = info.hue;
  m.flags = info.flags;
  m.x = info.x;
  m.y = info.y;
  m.z = info.z;
  // Mobile packets have the same implicit-facet contract as world items.
  // Stamp before reindexMobile() so NPCs enter the active map's sector.
  m.map = world.mapId | 0;
  // Keep facing and run state separate. The wire direction byte embeds
  // running in bit 0x80; storing the full byte made `player.direction !==
  // nextFacing` true on every running packet, so the client repeatedly
  // reserved cheap turn steps instead of real 200 ms run steps. Animation
  // looked like running while tile throughput stayed near walking speed.
  m.direction = info.direction & DIR_MASK;
  m.moveRunning = (info.direction & DIR_RUNNING_BIT) !== 0;
  // A normal mobile update is authoritative for resurrection/body-form
  // changes. Without clearing this latch a resurrected character stayed
  // greyed out and untargetable after an earlier 0xAF death action.
  m.dead = isDeadBody(info.body);
  if (info.notoriety != null) m.notoriety = info.notoriety;
}

function _clearMobileEquipment(m) {
  let hadEquipment = false;
  if (m.equipment) {
    for (const eq of m.equipment.values()) {
      hadEquipment = true;
      if (eq?.serial != null) world._equipIndex.delete((eq.serial >>> 0));
    }
  }
  if (m.equipment?.clear && m.equipment?.set) m.equipment.clear();
  else m.equipment = new Map();
  if (hadEquipment) {
    m._equipmentRevision = ((m._equipmentRevision | 0) + 1) >>> 0;
    m._equipmentHashRevision = -1;
  }
}

/** @param {import('./net-client.js').NetClient} net */
export function registerHandlers(net) {
  const delayedDeathRemovals = new Map();
  let loginConfirmSerial = 0;
  let customHouseDecodeQueue = Promise.resolve();
  let customHouseSession = 0;
  bus.on('net:close', () => {
    customHouseSession++;
    for (const timer of delayedDeathRemovals.values()) clearTimeout(timer);
    delayedDeathRemovals.clear();
  });
  bus.on('net:session-reset', () => {
    for (const timer of delayedDeathRemovals.values()) clearTimeout(timer);
    delayedDeathRemovals.clear();
    loginConfirmSerial = 0;
    resetNodeUOModernState();
    world.reset();
    bus.emit('atmosphere:weather', { kind: 0xFE, particles: 0, temperature: 0 });
    bus.emit('atmosphere:light', { level: 0, reset: true });
    bus.emit('atmosphere:season', { season: 1, playSound: false, reset: true });
  });
  bus.on('net:resync-request', () => {
    // CUO ClientResyncRequest is opcode + two reserved zero bytes. It is
    // unrelated to the 0x02 movement sequence (0x22 in the opposite
    // direction is MovementAck). Sending world.moveSequence here was a
    // non-canonical payload and confused strict emulator diagnostics.
    try { net.send(buildResyncRequest()); } catch { /* socket */ }
  });
  const emitRareOpcode = (opcode, pkt, event = null, extra = {}) => {
    const payload = { opcode, length: pkt?.length ?? 0, raw: pkt, ...extra };
    if (event) bus.emit(event, payload);
    bus.emit('net:rare-opcode', payload);
  };

  // ---- Login handshake ----------------------------------------------------

  net.on(0x82, (pkt) => {
    const { reason } = decodeLoginRejection(pkt);
    bus.emit('login:rejected', { reason });
  });

  net.on(0x53, (pkt) => {
    const { reason } = decodeConnectionError(pkt);
    bus.emit('login:rejected', { reason, source: 'connection-error' });
  });

  net.on(0xA8, (pkt) => bus.emit('login:server-list', decodeServerList(pkt)));
  net.on(0x8C, (pkt) => bus.emit('login:relay',       decodePlayServerAck(pkt)));
  net.on(0xA9, (pkt) => bus.emit('login:char-list',   decodeCharacterList(pkt)));
  // Audit #38 P2 #6 — 0x86 ResendCharacterList. CUO
  // `PacketHandlers.cs:5959` updates the login-screen slot list after
  // a delete. Was: framer accepted but no handler — deleted slot
  // appeared occupied until reconnect. Same body shape as 0xA9.
  net.on(0x86, (pkt) => bus.emit('login:char-list',   decodeCharacterList(pkt)));
  // Audit #36 P1 #2 — 0xC8 ClientViewRange (server push). CUO
  // `PacketHandlers.cs:2517` stores `world.ClientViewRange = pkt[1]`.
  // Servers use this to clamp the client's perception range (e.g.
  // shrink near a guild war zone). Was: decoded in the framer but no
  // subscriber, so `world.viewRange` stayed at the local default and
  // health-bars / name-overheads ranged on stale 18.
  net.on(0xC8, (pkt) => {
    if (pkt.length < 2) return;
    const range = pkt[1] | 0;
    world.viewRange = range;
    bus.emit('view:range', { range });
  });
  net.on(0xB9, (pkt) => {
    const info = decodeSupportedFeatures(pkt);
    // Audit #31 P1 #4 — store the feature flags on `world` so feature-
    // gated systems (chat, animation body-convert table, char-slot
    // count, race option, expansion gumps) can read them. Previously
    // the packet was decoded and forgotten — `world.clientFeatures`
    // stayed undefined and every consumer fell through to its T2A-era
    // default regardless of which expansion the shard ran.
    world.clientFeatures = (info?.flags | 0);
    bus.emit('login:features', info);
  });
  // ServUO sends 0xBD with empty payload as a "give me your client
  // version" REQUEST. The proper ClassicUO response is to echo our
  // own 0xBD back with the version string. Sending 0xBD proactively
  // before this server-side request triggers ServUO's "Packet (0xBD)
  // Requires State Mobile" disconnect — so we wait for the request
  // and reply on demand.
  net.on(0xBD, () => {
    try { net.send(buildClientVersion('7.0.95.0')); }
    catch { /* socket transient */ }
  });

  net.on(0x1B, (pkt) => {
    const info = decodeLoginConfirm(pkt);
    const duplicate = loginConfirmSerial === (info.serial >>> 0) && world.player?.serial === (info.serial >>> 0);
    loginConfirmSerial = info.serial >>> 0;
    const m = world.ensureMobile(info.serial);
    m.body = info.body; m.x = info.x; m.y = info.y; m.z = info.z;
    m.direction = info.direction; m.isPlayer = true;
    world.player = m;
    world.mapWidth = info.mapWidth;
    world.mapHeight = info.mapHeight;
    world.moveSequence = 0;
    bus.emit(duplicate ? 'world:login-confirm-duplicate' : 'world:login-confirm', info);
  });

  net.on(0x55, (_pkt) => {
    bus.emit('world:login-complete', decodeLoginComplete());
    // Audit #39 client P2 #7 — CUO's LoginComplete handler sends a small
    // burst right after: ClientType (0xBF 0x0F), ClientViewRange, then
    // SkillsRequest so the Skills gump pre-populates. Without these
    // ServUO classified us as legacy AOS and never pushed KR-only
    // paperdoll layers (Bracelet of Binding, Crimson Cincture).
    try {
      net.send(buildClientType());
      if (world.player?.serial) net.send(buildSkillsRequest(world.player.serial));
    } catch { /* best effort */ }
  });

  // ---- World state --------------------------------------------------------

  net.on(0x77, (pkt) => {
    const info = decodeMobileMoving(pkt);
    const m = world.ensureMobile(info.serial);
    // Polymorph / form-change: when the body graphic changes, every
    // equipped layer becomes irrelevant (creature bodies don't even
    // have a layer-table). Without this clear the cape / armor etc.
    // overlays kept rendering on top of the new body — a skeleton in
    // a cloak. Server's broadcastBodyChange only ships body+flags via
    // 0x77/0x20, never re-emits 0x78 with the new equipment list.
    // Polymorph wipe — but NEVER for the local player. The server
    // sometimes broadcasts a self 0x77 with body=400 right after an
    // animation-tagged 0x77 (cast anim restart, mount/dismount,
    // war-mode toggle). Wiping the player's `equipment` Map there
    // dropped the cached backpack ref, then any subsequent code path
    // that read `world.player.equipment.get(21)` saw `undefined` and
    // threw mid-batch — killing every following packet handler in the
    // same WebSocket message and freezing the game right after a
    // targeting cancel. The actual polymorph push for the SUBJECT
    // comes through 0x20 (handled below), not 0x77.
    const isSelf77 = world.player && info.serial === world.player.serial;
    if (info.body !== m.body && m.body !== 0 && !isSelf77) {
      // Drop reverse-index entries for the equipment we're about to wipe.
      _clearMobileEquipment(m);
    }
    // Compute the tile-step delta BEFORE we overwrite x/y so the
    // sprite can lerp from the old tile to the new one. Skip the
    // first sighting (no prior position → no slide) and any update
    // larger than 1 tile (teleport / 0x20 update channel).
    const oldX = m.x, oldY = m.y, oldMap = m.map ?? 1;
    const hadPos = m.x !== 0 || m.y !== 0 || m.z !== 0;
    const dx = info.x - m.x, dy = info.y - m.y, dz = info.z - m.z;
    const oneStep = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dz) <= 5;
    const isSelf  = world.player && info.serial === world.player.serial;
    const noChange = dx === 0 && dy === 0 && dz === 0;
    // Self z-correction echo: server emits 0x77 to the moving player
    // ONLY when its movement step changed elevation, so the client can
    // snap to authoritative z without waiting for nearby observers'
    // broadcast. We've already updated x/y/z optimistically in
    // _onMovementAck — re-running beginMoveStep here would cancel the
    // walk lerp mid-flight. Treat (dx=dy=dz=0) on self as just-store.
    _applyMobilePacketFields(m, info);
    world.reindexMobile?.(m, oldX, oldY, oldMap);
    _applySelfWarLatch(m);
    if (isSelf && noChange) {
      // No-op — keep the in-flight lerp going.
    } else if (isSelf && dx === 0 && dy === 0 && dz !== 0) {
      // Self z-correction echo. _onMovementAck already started a walk
      // lerp using the locally-resolved z; if the server's authoritative
      // z differs we just SNAP m.z (Object.assign already did) and let
      // the in-flight lerp ride out — restarting beginMoveStep here
      // produced a visible "pop" each step on stairs because the lerp
      // restart lifted the sprite to its new start point and then
      // re-lerped to zero, causing a doubled vertical motion.
    } else if (hadPos && oneStep && (dx !== 0 || dy !== 0 || dz !== 0)) {
      // CUO: run bit lives in the direction byte (0x80), NOT in flags.
      // The mobile flags byte's 0x40 is FLAG_WARMODE — earlier this
      // line read warmode-as-run, so warmoded NPCs lerped at 200ms and
      // every walking-with-spellbook player accidentally "ran" because
      // their own war-toggle flipped this bit.
      const run = (info.direction & 0x80) !== 0;
      const now = performance.now();
      // If a previous step is still lerping (NPC scripted multi-tile
      // MoveTo arriving every server tick), enqueue rather than restart.
      // The renderer drains the next step when the current one finishes.
      if (!isSelf && m.offsetEndAt > now) {
        m.enqueueStep(dx, dy, dz, run, info.direction & 7);
      } else {
        const durationMs = m.isMounted
          ? (run ? 100 : 200)
          : (run ? 200 : 400);
        m.beginMoveStep(dx, dy, dz, durationMs, now, run);
      }
    } else if (!isSelf) {
      m.offsetX = m.offsetY = m.offsetZ = 0;
      m.offsetEndAt = 0;
    }
    bus.emit('mobile:moving', m);
  });

  net.on(0x78, (pkt) => {
    const info = decodeMobileIncoming(pkt);
    const m = world.ensureMobile(info.serial);
    if ((world.player?.serial >>> 0) === (info.serial >>> 0) && world.player !== m) {
      // Player death uses RemoveEntity → MobileIncoming(ghost). Rebind
      // the singleton to the freshly rebuilt Mobile or the renderer and
      // walker continue reading the removed, living object forever.
      m.isPlayer = true;
      world.player = m;
    }
    const oldX = m.x, oldY = m.y, oldMap = m.map ?? 1;
    // 0x78 is normally a full equipment snapshot, but a large amount of
    // ServUO-style content uses an empty equipment tail merely to refresh a
    // flag/name/hue (reveal, facing, notoriety). Treating that empty tail as
    // "strip every layer" made robes/gloves/backpacks disappear until a later
    // authoritative equip update arrived. A body change is still a genuine
    // rebuild (death/polymorph), and a non-empty tail remains authoritative.
    // Explicit unequips arrive as 0x1D and already remove their one layer.
    const bodyChanged = m.body !== 0 && info.body !== m.body;
    const replaceEquipment = bodyChanged
      || (info.equipment?.length ?? 0) > 0
      || (m.equipment?.size ?? 0) === 0;
    _applyMobilePacketFields(m, info);
    world.reindexMobile?.(m, oldX, oldY, oldMap);
    if (replaceEquipment) world.replaceEquipment(m, info.equipment ?? []);
    _applySelfWarLatch(m);
    bus.emit('mobile:incoming', m);
  });

  net.on(0x20, (pkt) => {
    const info = decodeMobileUpdate(pkt);
    const m = world.ensureMobile(info.serial);
    const oldX = m.x, oldY = m.y, oldMap = m.map ?? 1;
    // Same body-change wipe as 0x77 — 0x20 is the channel server uses
    // to push polymorph / wraith-form / horrific-beast to the SUBJECT
    // (mobileUpdate goes to the caster's own client, mobileMoving to
    // observers). Both paths must clear stale equipment.
    if (info.body !== m.body && m.body !== 0) {
      _clearMobileEquipment(m);
    }
    // Teleport detection — 0x20 is the channel server uses to SNAP
    // the player to a new tile (admin TP, [tele, [go, recall, moongate,
    // resync). Without resetting walker state the in-flight pre-TP
    // 0x02 packets get rejected once they reach the server (they
    // referenced the old tile), `_inFlight` stays elevated, `_lastStepAt`
    // sits in the future, `resyncRequested` latches true and never gets
    // cleared — net result: hold W/A/S/D does nothing for 5+ seconds
    // after every TP because canStep() returns false the whole time.
    // Detect a jump of >1 tile on the SELF channel and wipe the walker
    // + the predicted-move queue + lerp offsets so the next keypress
    // hits a clean baseline.
    const isSelf = world.player && info.serial === world.player.serial;
    if (isSelf) {
      const dx = (info.x | 0) - (m.x | 0);
      const dy = (info.y | 0) - (m.y | 0);
      const hadPos = (m.x | 0) !== 0 || (m.y | 0) !== 0;
      const jumped = hadPos && (Math.abs(dx) > 1 || Math.abs(dy) > 1);
      if (jumped) {
        walker.reset();
        m.offsetX = 0; m.offsetY = 0; m.offsetZ = 0;
        m.offsetStartX = 0; m.offsetStartY = 0; m.offsetStartZ = 0;
        m.offsetStartAt = 0; m.offsetEndAt = 0;
        m.clearSteps?.();
        world.moveSequence = 0;
        // Evict far mobiles so world.mobiles doesn't grow without
        // bound across multi-TP sessions. We strip anyone outside a
        // 60-tile box around the new player position; their visuals
        // are already off-screen and the next 0x78 nearby-incoming
        // will re-add them if they wander back into range.
        const FAR = 60;
        const removed = [];
        world.batchSpatialMutations?.(() => {
          for (const other of world.mobiles.values()) {
            if (other === m) continue;
            if (other.client) continue;     // never evict another player
            if (Math.abs(other.x - info.x) > FAR || Math.abs(other.y - info.y) > FAR) {
              world.removeEntity(other.serial);
              removed.push(other.serial);
            }
          }
        });
        for (const serial of removed) {
          bus.emit('entity:removed', { serial });
        }
        bus.emit('player:teleported', { x: info.x | 0, y: info.y | 0, z: info.z | 0 });
      }
    }
    const clearsWalkerResync = isSelf && walker.resyncRequested;
    _applyMobilePacketFields(m, info);
    if (clearsWalkerResync) {
      walker.clearResync();
      bus.emit('player:resynced', { x: info.x | 0, y: info.y | 0, z: info.z | 0 });
    }
    world.reindexMobile?.(m, oldX, oldY, oldMap);
    _applySelfWarLatch(m);
    bus.emit('mobile:update', m);
  });

  net.on(0x1D, (pkt) => {
    // RemoveEntity (5B) — opcode + u32 serial.
    const serial = ((pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]) >>> 0;
    const dyingNpc = serial !== (world.player?.serial >>> 0)
      && corpseManager.exists(0, serial)
      && world.mobiles.get(serial)?.dead;
    if (dyingNpc) {
      if (!delayedDeathRemovals.has(serial)) {
        const timer = setTimeout(() => {
          delayedDeathRemovals.delete(serial);
          corpseManager.remove(0, serial);
          world.removeEntity(serial);
          bus.emit('entity:removed', { serial });
        }, 480);
        delayedDeathRemovals.set(serial, timer);
      }
      return;
    }
    // If we had this serial registered as a "death in flight" (mobile that
    // dropped a corpse), commit the corpse facing now and let the manager
    // forget the entry. The corpse Item itself can outlive its owner.
    if (corpseManager.exists(0, serial) || corpseManager.exists(serial, 0)) {
      corpseManager.remove(serial, serial);
    }
    world.removeEntity(serial);
    bus.emit('entity:removed', { serial });
  });

  // ---- World items (legacy 0x1A + modern 0xF3) ---------------------------

  net.on(0x1A, (pkt) => {
    const info = decodeWorldItem(pkt);
    const it = world.ensureItem(info.serial);
    const oldParent = it.parent | 0;
    const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1;
    applyWorldItemInfo(it, info);
    it.multiId = info.type === 2 ? info.graphic : null;
    it.isCorpse = info.type === 1;
    // Audit #34 P1 #1 — `decodeWorldItem` only returns `type: 0 | 2`,
    // never 1, so the `info.type === 1` branch above never fires on
    // 0x1A. CUO `Item.IsCorpse` is derived from `graphic === 0x2006`.
    // Without this, corpses dropped on legacy frames (or non-AOS
    // clients) rendered as static art instead of routing through
    // `_mountCorpseSprite` with the corpse body lookup.
    if (info.graphic === 0x2006) it.isCorpse = true;
    world.linkItemParent(it, oldParent);
    world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
    bus.emit('item:placed', it);
  });
  net.on(0xF3, (pkt) => {
    const info = decodeWorldItemSA(pkt);
    const it = world.ensureItem(info.serial);
    const oldParent = it.parent | 0;
    const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1;
    applyWorldItemInfo(it, info);
    it.multiId = info.type === 2 ? info.graphic : null;
    it.isCorpse = info.type === 1;
    // Audit #34 P1 #1 — mirror the 0x1A fix for SA frames that also
    // sometimes ship corpse graphics without the type byte set.
    if (info.graphic === 0x2006) it.isCorpse = true;
    world.linkItemParent(it, oldParent);
    world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
    bus.emit('item:placed', it);
  });
  // Audit #38 P1 #1 — 0xF7 PacketList wraps N inner sub-packets
  // (currently only 0xF3) into one envelope. CUO
  // `PacketHandlers.cs:5903`. Was: framer dispatched as a single
  // variable-length packet, no handler — every batched-spawn item in
  // a busy sector was silently dropped (vendor shops, dungeon entry).
  net.on(0xF7, (pkt) => {
    if (pkt.length < 5) return;
    // Layout: op(1) + len(2) + count(2) + (sub-packets back-to-back).
    const count = (pkt[3] << 8) | pkt[4];
    let off = 5;
    const placed = [];
    world.batchSpatialMutations?.(() => {
      for (let i = 0; i < count && off < pkt.length; i++) {
        const subOp = pkt[off];
        if (subOp !== 0xF3) {
          // Unknown sub-op — abort. Inner SA item packets are 26 bytes.
          break;
        }
        const SUB_LEN = 26;
        if (off + SUB_LEN > pkt.length) break;
        const subPkt = pkt.subarray(off, off + SUB_LEN);
        try {
          const info = decodeWorldItemSA(subPkt);
          const it = world.ensureItem(info.serial);
          const oldParent = it.parent | 0;
          const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1;
          applyWorldItemInfo(it, info);
          it.multiId = info.type === 2 ? info.graphic : null;
          it.isCorpse = info.type === 1;
          if (info.graphic === 0x2006) it.isCorpse = true;
          world.linkItemParent(it, oldParent);
          world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
          placed.push(it);
        } catch (e) { console.warn('[0xF7] sub-packet decode failed', e); }
        off += SUB_LEN;
      }
    });
    for (const it of placed) bus.emit('item:placed', it);
  });

  // ---- Attributes ---------------------------------------------------------

  net.on(0xA1, (pkt) => {
    const info = decodeAttributeUpdate(pkt);
    // Client audit #3 #2: race condition — 0xA1 can arrive before the
    // matching 0x78 (resync burst). Use ensureMobile so the stub
    // catches the value; the next 0x78 will fill body/hue/position.
    const m = world.ensureMobile(info.serial);
    if (typeof m.hp === 'number') {
      const delta = info.current - m.hp;
      if (delta > 0) bus.emit('heal:apply',  { serial: info.serial, amount: delta });
    }
    m.hp = info.current; m.hpMax = info.max;
    bus.emit('mobile:hp', info);
  });
  net.on(0xA2, (pkt) => {
    const info = decodeAttributeUpdate(pkt);
    // #2 — same race for mana.
    const m = world.ensureMobile(info.serial);
    m.mana = info.current; m.manaMax = info.max;
    // Audit #39 client P3 #11 — 0x2D writes both pairs but 0xA2 only
    // updated `mana/manaMax`. Anything reading `mob.mp` directly (party
    // widget, extension hooks) kept seeing stale values until the next
    // 0x2D status push. Sync both aliases so the two readers agree.
    m.mp = info.current; m.mpMax = info.max;
    bus.emit('mobile:mana', info);
  });
  net.on(0xA3, (pkt) => {
    const info = decodeAttributeUpdate(pkt);
    const m = world.ensureMobile(info.serial);
    m.stam = info.current; m.stamMax = info.max;
    m.st   = info.current; m.stMax   = info.max;
    bus.emit('mobile:stamina', info);
  });

  // ---- Movement -----------------------------------------------------------

  net.on(0x22, (pkt) => {
    const info = decodeMovementAck(pkt);
    if (net.tracePackets) {
      console.log(`[trace rx] 0x22 MovementAck seq=${info.sequence} noto=${info.notoriety}`);
    }
    bus.emit('movement:ack', info);
  });
  net.on(0x21, (pkt) => {
    const info = decodeMovementRej(pkt);
    if (net.tracePackets) {
      console.log(`[trace rx] 0x21 MovementRej seq=${info.sequence} snapTo=(${info.x},${info.y},${info.z}) dir=${info.direction}`);
    }
    bus.emit('movement:rej', info);
  });

  // ---- Atmosphere ---------------------------------------------------------

  net.on(0x4F, (pkt) => {
    const { level } = decodeOverallLight(pkt);
    world.lightLevel = level;
    world.lastLightPacketAt = Date.now();
    bus.emit('atmosphere:light', { level });
  });
  net.on(0xBC, (pkt) => {
    const info = decodeSeason(pkt);
    world.season = info.season;
    bus.emit('atmosphere:season', info);
    // Audit #33 P2.3 — when the playSound flag is set, re-emit the
    // last music id so AudioManager refreshes the track for the new
    // season. CUO `World.ChangeSeason(season, music)` plays
    // `OldMusicIndex` on every transition. Without this, autumn music
    // kept playing in winter.
    if (info.playSound && Number.isFinite(world.lastMusicId)) {
      bus.emit('atmosphere:music', { musicId: world.lastMusicId });
    }
  });
  net.on(0x65, (pkt) => bus.emit('atmosphere:weather', decodeWeather(pkt)));
  net.on(0x6D, (pkt) => {
    const info = decodePlayMusic(pkt);
    // Audit #33 P2.3 — stash the last music id so a 0xBC season packet
    // with playSound=1 can re-trigger the same track. CUO routes both
    // through `World.OldMusicIndex`.
    if (Number.isFinite(info?.musicId)) world.lastMusicId = info.musicId;
    bus.emit('atmosphere:music', info);
  });
  net.on(0x54, (pkt) => bus.emit('audio:sfx',          decodePlaySound(pkt)));
  // 0xF5 NewMapMessage — treasure map / cartography pin update.
  // Surfaces a `map:pin-update` event the cartography gump can read.
  net.on(0xF5, (pkt) => bus.emit('map:pin-update', decodeNewMapMessage(pkt)));
  // 0xF0 Krrios envelope — used by Razor / Steam / EUO clients for
  // out-of-band party / loot reservation chatter. We decode the
  // sub-type byte; downstream listeners can register on
  // `net:krrios` to consume specific protocols.
  net.on(0xF0, (pkt) => bus.emit('net:krrios', decodeKrrios(pkt)));
  // 0x5B SetTime — no-op in CUO (server clock is purely informational
  // for our day/night already-driven-from-overall-light packet 0x4F).
  // We accept the packet so the framer doesn't desync, but emit no event.
  net.on(0x5B, () => { /* server-time notification, ignored */ });
  // 0x56 MapData — paper-map pin add/remove/clear/edit. Only meaningful
  // when a MapGump is open; we surface an event so a future map UI can
  // listen without us re-wiring the framer.
  net.on(0x56, (pkt) => {
    if (pkt.length < 11) return;
    const serial = ((pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]) >>> 0;
    const cmd = pkt[5];   // 1=Add, 2=Insert, 3=Move, 4=Remove, 5=Clear, 6=Edit, 7=EditResp
    const pinNum = pkt[6];
    const x = (pkt[7] << 8) | pkt[8];
    const y = (pkt[9] << 8) | pkt[10];
    bus.emit('mapgump:pin', { serial, cmd, pinNum, x, y });
  });

  // Audit #32 P1 #3 — 0x90 DisplayMap (size 19). CUO
  // `PacketHandlers.cs:3145-3186` opens MapGump with bounding box +
  // facet for cartography / treasure-map double-click. Was declared in
  // the packet table but had no handler — server's reply to a treasure
  // map open silently dropped; user clicked the map and nothing
  // happened. Pre-308Z clients use 0x90; modern AOS uses 0xF5
  // NewMapMessage which we already handle.
  net.on(0x90, (pkt) => {
    if (pkt.length < 19) return;
    const serial = ((pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]) >>> 0;
    const gump = (pkt[5] << 8) | pkt[6];
    const x1 = (pkt[7]  << 8) | pkt[8];
    const y1 = (pkt[9]  << 8) | pkt[10];
    const x2 = (pkt[11] << 8) | pkt[12];
    const y2 = (pkt[13] << 8) | pkt[14];
    const w  = (pkt[15] << 8) | pkt[16];
    const h  = (pkt[17] << 8) | pkt[18];
    bus.emit('mapgump:display', { serial, gump, x1, y1, x2, y2, width: w, height: h });
  });

  // ---- Tooltips / war mode / effects -------------------------------------

  net.on(0xD6, (pkt) => bus.emit('tooltip:lines',  decodeMegaCliloc(pkt)));
  net.on(0xDC, (pkt) => bus.emit('tooltip:revision', decodeOPLInfo(pkt)));
  net.on(0x72, (pkt) => {
    const info = decodeWarMode(pkt);
    // Mirror the war bit onto `world.player.flags`. Server's
    // `nearbyClients(world, mob, mob)` excludes self from the
    // mobileIncoming broadcast, so the player NEVER receives a
    // refreshed `flags` byte for their own warmode toggle on the
    // standard path. We derive `mob.warMode` from FLAG_WARMODE in the
    // world.js flags accessor — it can only flip when something writes
    // `flags`, and 0x72 alone wouldn't, hence the explicit mirror.
    //
    // PLUS — pin the latest authoritative war state so the sticky-bit
    // guard in 0x77/0x78/0x20 handlers can re-apply it after any
    // self-targeted Object.assign with a stale flags byte. Without the
    // guard, a delayed 0x77 z-correction echo carrying the old war
    // bit could clobber the just-mirrored state and the player would
    // bounce back into war stance immediately after toggling off.
    _selfWarLatch = { warMode: info.warMode, at: performance.now() };
    if (world.player) {
      const bit = 0x40;
      world.player.flags = info.warMode
        ? ((world.player.flags | 0) | bit)
        : ((world.player.flags | 0) & ~bit);
    }
    bus.emit('player:warmode', info);
  });
  const _emitCombatDamage = (info) => {
    if (!info || info.amount <= 0) return;
    // Keep one canonical combat event for state/music/macros and one visual
    // event for hit flash/recoil/world text. Both legacy 0x0B and AOS 0x22
    // must take this path; previously each drove only half of the feedback.
    bus.emit('combat:damage', info);
    bus.emit('damage:apply', info);
  };
  net.on(0x0B, (pkt) => {
    const info = decodeDamage(pkt);
    _emitCombatDamage(info);
  });
  // Spell-effect → matching SFX. The classic UO PlayMagicEffect path
  // bundles a sound with each graphic effect (CUO `MagicEffectsLoader`).
  // We tag the most common spell projectile graphics so casts are
  // audible on observers (caster's own sound goes via 0x54).
  const SPELL_FX_SOUND = {
    0x36BD: 0x208,  // Magic Arrow / Fireball impact
    0x36D4: 0x208,  // Energy Bolt
    0x3779: 0x213,  // Lightning bolt
    0x36E4: 0x1F1,  // Fire field flame
    0x37CC: 0x1F4,  // Cold area / Ice field
    0x374A: 0x1F7,  // Poison field bubble
    0x375A: 0x208,  // Generic conjure ring
    0x3728: 0x1FB,  // Heal aura
    0x3818: 0x213,  // Earthquake rumble
  };
  function _spellSfxOf(graphic) { return SPELL_FX_SOUND[graphic & 0xFFFF] | 0; }
  // Effects that should shake the camera. Magnitude/duration tuned to feel
  // like CUO's `Camera.Shake` impulses (explosion big, fireball small).
  /** @type {Record<number, {mag:number, dur:number}>} */
  const SCREEN_SHAKE = {
    0x36B0: { mag: 14, dur: 360 }, // Explosion
    0x36BD: { mag:  5, dur: 180 }, // Fireball / magic arrow
    0x3818: { mag: 18, dur: 520 }, // Earthquake rumble
    0x36D4: { mag:  4, dur: 140 }, // Energy bolt
  };
  // Client audit #3 #1: decoder fields are `graphic` + `sx/sy/sz`, NOT
  // `itemId` + `fromX/fromY/fromZ`. Previously the lookup always missed
  // and the bus.emit('audio:sfx', { … x:undefined }) silently failed.
  function _maybeShake(info) {
    // Only shake when the effect is near the player (≤8 tiles). Distant
    // earthquake jiggling the screen would be irritating and break the
    // visual link between an impact and its source.
    const shake = SCREEN_SHAKE[(info.graphic ?? 0) & 0xFFFF];
    if (!shake) return;
    const me = world.player;
    if (!me) return;
    const fx = info.tx ?? info.sx ?? 0;
    const fy = info.ty ?? info.sy ?? 0;
    if (Math.abs(fx - me.x) > 8 || Math.abs(fy - me.y) > 8) return;
    bus.emit('camera:shake', { magnitude: shake.mag, durationMs: shake.dur });
  }
  function _routeGraphicEffect(info) {
    // OSI/CUO type 4 is a viewport fade, not a drag tether. `graphic`
    // carries a small mode (0..4); keep the transition short and bounded.
    if ((info?.type | 0) === 4) {
      const mode = Math.max(0, Math.min(4, info.graphic | 0));
      bus.emit('weather:flash', {
        durationMs: 260 + mode * 90,
        color: mode >= 3 ? 0x000000 : 0xffffff,
        alpha: mode >= 3 ? 0.72 : 0.58,
      });
      return false;
    }
    bus.emit('fx:graphic', info);
    return true;
  }
  net.on(0x70, (pkt) => {
    const info = decodeGraphicEffect(pkt);
    if (!_routeGraphicEffect(info)) return;
    const sid = _spellSfxOf(info.graphic);
    if (sid) bus.emit('audio:sfx', { sound: sid, x: info.sx, y: info.sy, z: info.sz });
    _maybeShake(info);
  });
  net.on(0xC0, (pkt) => {
    const info = decodeGraphicEffectHued(pkt);
    if (!_routeGraphicEffect(info)) return;
    const sid = _spellSfxOf(info.graphic);
    if (sid) bus.emit('audio:sfx', { sound: sid, x: info.sx, y: info.sy, z: info.sz });
    _maybeShake(info);
  });
  // Audit #39 client P2 #6 — 0xC7 carries an extra explode-sound, an
  // attached-mobile serial (for type-3 effects that follow a mobile)
  // and the tileId of the projectile. Routing through Hued dropped all
  // of that. Emit the bundled SFX and pass the full payload through to
  // `effect-renderer` so type-3 attaches properly.
  net.on(0xC7, (pkt) => {
    const info = decodeGraphicEffectExt(pkt);
    if (!_routeGraphicEffect(info)) return;
    if (!info.explodeSound) {
      const sid = _spellSfxOf(info.graphic);
      if (sid) bus.emit('audio:sfx', { sound: sid, x: info.sx, y: info.sy, z: info.sz });
    }
  });
  // Rare-but-declared packets that ClassicUO registers explicitly and
  // mostly treats as pass-through/no-op surfaces. Keeping handlers here
  // makes the protocol coverage honest: the framer accepts the packets,
  // diagnostics can observe them, and future UI can subscribe without
  // another packet-table audit.
  net.on(0xC3, (pkt) => emitRareOpcode(0xC3, pkt, 'fx:particle'));
  net.on(0xC6, (pkt) => emitRareOpcode(0xC6, pkt, 'notice-board:packet'));
  net.on(0xC9, (pkt) => emitRareOpcode(0xC9, pkt, 'fx:hued-short'));
  net.on(0xCA, (pkt) => emitRareOpcode(0xCA, pkt, 'ui:highlight-packet'));
  net.on(0xD0, (pkt) => emitRareOpcode(0xD0, pkt, 'config:file-packet'));
  net.on(0xDB, (pkt) => emitRareOpcode(0xDB, pkt, 'character-transfer:log'));
  // Audit close-out — every opcode declared in `incoming-table.js` should
  // have either behavior or an explicit diagnostic stub here. These are
  // rare/legacy packets CUO can frame without doing much with them; keeping
  // them as named handlers makes compatibility gaps visible without
  // dropping the stream into the generic "unhandled" path.
  net.on(0x15, (pkt) => emitRareOpcode(0x15, pkt, 'locale:character'));
  net.on(0x1F, (pkt) => emitRareOpcode(0x1F, pkt, 'mobile:old-health-update'));
  net.on(0x2B, (pkt) => emitRareOpcode(0x2B, pkt, 'pathfind:message'));
  net.on(0x32, (pkt) => emitRareOpcode(0x32, pkt, 'net:unknown32'));
  net.on(0x61, (pkt) => emitRareOpcode(0x61, pkt, 'entity:legacy-delete-packet'));
  net.on(0x6B, (pkt) => emitRareOpcode(0x6B, pkt, 'godmode:request-packet'));
  net.on(0x81, (pkt) => emitRareOpcode(0x81, pkt, 'login:char-list-play-packet'));
  net.on(0xBE, (pkt) => emitRareOpcode(0xBE, pkt, 'assist:version-packet'));
  net.on(0xD9, (pkt) => emitRareOpcode(0xD9, pkt, 'spy:client-packet'));
  net.on(0xF1, (pkt) => emitRareOpcode(0xF1, pkt, 'freeshard:list-packet'));
  net.on(0x7B, (pkt) => {
    const info = { season: pkt[1] | 0, playSound: false, legacy: true };
    world.season = info.season;
    bus.emit('atmosphere:season', info);
  });

  // ---- Character animations ----------------------------------------------

  // Client audit #5 #3 — pass through the full decode payload
  // (frameCount/repeatCount/delay) so authored emote duration is honored
  // by the renderer instead of falling back to defaults.
  net.on(0x6E, (pkt) => {
    bus.emit('anim:custom', decodeCharacterAnimation(pkt));
  });
  net.on(0xE2, (pkt) => {
    bus.emit('anim:custom', decodeNewCharacterAnimation(pkt));
  });

  // 0xBB UltimaMessenger — 9B legacy "you have N unread messages" badge.
  // Layout: `op + u32 senderSerial + u32 recipientSerial`. Most modern
  // shards don't emit this (they use bulletin boards via 0x71 instead),
  // but a handful of old freeshards still send the badge on login. We
  // surface it as an event so any future inbox gump can listen.
  net.on(0xBB, (pkt) => {
    if (pkt.length < 9) return;
    const sender   = ((pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]) >>> 0;
    const recipient= ((pkt[5] << 24) | (pkt[6] << 16) | (pkt[7] << 8) | pkt[8]) >>> 0;
    bus.emit('mail:badge', { sender, recipient });
  });
  // 0x8B UltimaMessenger (VAR) — full mail payload. Layout (per ServUO
  // archived spec): op + len(2) + u32 sender + u32 recipient + ascii
  // subject(zero-terminated) + ascii body(zero-terminated). Defensive
  // decode — body length not always reliable.
  net.on(0x8B, (pkt) => {
    if (pkt.length < 11) return;
    const sender    = ((pkt[3] << 24) | (pkt[4] << 16) | (pkt[5] << 8) | pkt[6]) >>> 0;
    const recipient = ((pkt[7] << 24) | (pkt[8] << 16) | (pkt[9] << 8) | pkt[10]) >>> 0;
    let off = 11;
    let subject = '';
    while (off < pkt.length && pkt[off] !== 0) {
      subject += String.fromCharCode(pkt[off]); off++;
    }
    off++;
    let body = '';
    while (off < pkt.length && pkt[off] !== 0) {
      body += String.fromCharCode(pkt[off]); off++;
    }
    bus.emit('mail:message', { sender, recipient, subject, body });
  });

  // 0x38 Pathfind — 7B. Server-side step request: `op + x(2) + y(2) + z(2)`.
  // CUO `PacketHandlers.cs:Pathfinding` reads the destination and feeds it
  // to the local `Pathfinder.WalkTo`. We do the same: emit an event the
  // scene subscribes to and triggers `_beginAutowalk(tx, ty)`. Without
  // this, the server-initiated pathfind (e.g. travel NPCs that dispatch
  // 0x38, or `[goto` admin) silently failed because outgoing was one-way.
  net.on(0x38, (pkt) => {
    if (pkt.length < 7) return;
    const tx = ((pkt[1] << 8) | pkt[2]) & 0xffff;
    const ty = ((pkt[3] << 8) | pkt[4]) & 0xffff;
    // z is signed 16-bit (UO map z range −128..+127, but wire is i16).
    const rawZ = ((pkt[5] << 8) | pkt[6]) & 0xffff;
    const tz = rawZ >= 0x8000 ? rawZ - 0x10000 : rawZ;
    bus.emit('pathfind:server-request', { x: tx, y: ty, z: tz });
  });

  // 0xE3 KREncryptionResponse — VAR. KR-era client encryption negotiation
  // reply. CUO `PacketHandlers.cs:KrriosClientSpecial` ignores it (the
  // client picks its login encryption locally and the server just echoes
  // a handshake-acknowledged packet). Without this stub registered, the
  // packet still routes through the framer fine (entry in incoming-table
  // is VAR), but downstream subscribers never see an event. Some shard
  // setups use 0xE3 as a no-op keep-alive — emit it as an event so
  // diagnostic plugins can log it, but otherwise do nothing.
  net.on(0xE3, (pkt) => {
    // Audit #46 P2 — real KR-mode handshake reply. CUO `CryptManager.cs`
    // returns 0xE3 with the authId echoed back + a 9-byte sequence
    // (0x00..0x08) so the server knows the client supports modern
    // encryption negotiation. ServUO shards that don't speak KR ignore
    // the reply; KR shards require it. Layout per CUO PacketHandlers
    // KR section:
    //   op(1) + len(u16) + authId(u32) + payload...
    let authId = 0;
    if (pkt.length >= 7) {
      authId = ((pkt[3] << 24) | (pkt[4] << 16) | (pkt[5] << 8) | pkt[6]) >>> 0;
    }
    bus.emit('net:kr-encryption-response', { authId, length: pkt.length });
    // Lazy-load the protocol builder so non-KR sessions don't pay the
    // import cost. Fire-and-forget; if the import fails (e.g. SSR) we
    // simply skip the reply.
    import('@uo/protocol').then(({ buildKrHandshakeReply }) => {
      try { net.send(buildKrHandshakeReply(authId)); }
      catch { /* socket dropped */ }
    }).catch(() => { /* protocol not available */ });
  });

  // 0x93 OpenBookLegacy — 99B fixed. ServUO RunUO emits this for legacy
  // book items (BookItem.OnDoubleClick before SE). 0xD4 OpenBookNew is
  // the modern path. Without this stub, the framer accepts the bytes
  // but no subscriber fires → book gump never opens for legacy books.
  net.on(0x93, (pkt) => bus.emit('book:open', decodeOpenBookLegacy(pkt)));

  // 0xD7 GenericAOSCommands — VAR. Wrapper for AOS-era server→client
  // subops (quest menu, party stats, runebook updates, etc.). CUO
  // `PacketHandlers.cs:5075` declares it as empty stub; we mirror that
  // and emit a generic event for diagnostic plugins. Without this
  // registration the framer routes the bytes through correctly but no
  // subscriber sees them — harmless, but prevents future feature wiring.
  net.on(0xD7, (pkt) => {
    const subop = pkt.length >= 7 ? ((pkt[5] << 8) | pkt[6]) & 0xffff : 0;
    bus.emit('aos:cmd', { subop, length: pkt.length, raw: pkt });
  });

  // 0xDE UpdateMobileStatus — 1B attack-flag pushed for combat-confirmation.
  // ServUO rarely emits (mainstream uses 0x2F Swing). Stub avoids silent
  // null dispatch. CUO `PacketHandlers.cs:UpdateMobileStatus` reads 1u8.
  net.on(0xDE, (pkt) => {
    if (pkt.length >= 6) {
      const serial = u32(pkt, 1);
      const flag = pkt[5];
      bus.emit('mobile:status-flag', { serial, flag });
    }
  });

  // ---- Extra opcodes -----------------------------------------------------

  net.on(0x2D, (pkt) => {
    const info = decodeMobileAttributes(pkt);
    const m = world.mobiles.get(info.serial);
    if (m) {
      m.hp = info.hpCur; m.hpMax = info.hpMax;
      // Audit #30 P1 #3 — write BOTH the short-name (`mp`/`st`) and the
      // canonical (`mana`/`stam`) fields. Health-bar, party gump, and
      // status gump readers expect `mana/manaMax/stam/stamMax`; the
      // short-name fields were dead-ends, so party-member bars never
      // updated from 0x2D. 0xA2/0xA3 path already writes canonical.
      m.mp = info.mpCur; m.mpMax = info.mpMax;
      m.st = info.stCur; m.stMax = info.stMax;
      m.mana = info.mpCur; m.manaMax = info.mpMax;
      m.stam = info.stCur; m.stamMax = info.stMax;
    }
    bus.emit('mobile:attrs', info);
  });
  net.on(0x2E, (pkt) => {
    const info = decodeEquipUpdate(pkt);
    const m = world.mobiles.get(info.mobile);
    if (m) {
      world.equipOnMobile(m, info.layer, {
        serial: info.serial, itemId: info.itemId, hue: info.hue,
      });
    }
    // Mirror the item into `world.items` so callers that hold a serial
    // (e.g. ContainerGump opening the player's backpack) can resolve
    // its world data without needing the equipment Map. Without this
    // every double-click on the bag opened a "Container 0x..." gump
    // because the world had never heard of the item.
    const it = world.ensureItem(info.serial);
    const oldParent = it.parent | 0;
    const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1;
    const prevHue = it.hue;
    it.itemId = info.itemId;
    it.hue    = info.hue;
    it.layer  = info.layer;
    it.parent = info.mobile;
    world.linkItemParent(it, oldParent);
    world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
    bus.emit('mobile:equip', info);
    // Diagnostic — set `net.debugHues = true` or reload with
    // `localStorage.uoHueDebug = '1'`. Logs every hue change so the user can confirm the
    // 0x2E packet is arriving + carrying the expected hue when
    // [itemgump / [dye doesn't visually take.
    if (prevHue !== info.hue && net.debugHues) {
      console.log('[hue] 0x2E equipUpdate serial=0x%s hue %s → %s layer=%d',
        info.serial.toString(16), prevHue, info.hue, info.layer);
    }
  });
  net.on(0x2F, (pkt) => {
    const info = decodeSwing(pkt);
    const player = world.player;
    const inWarMode = player?.warMode ?? (((player?.flags ?? 0) & 0x40) !== 0);
    if (player && info.attacker === (player.serial >>> 0) && inWarMode) {
      const defender = world.mobiles.get(info.defender >>> 0);
      if (defender) {
        player.direction = directionFromDelta(defender.x - player.x, defender.y - player.y);
      }
    }
    bus.emit('combat:swing', info);
    _markInCombat();
  });

  net.on(0x97, (pkt) => {
    // Server-forced movement: turn/walk one step regardless of seq.
    // Audit #31 P1 #3 — CUO `PacketHandlers.cs:3266` calls
    // `world.Player.Walk(direction & 7, running)` so the player actually
    // takes a step. We previously only set `.direction` — boat ramming,
    // GM `[push`, teleport-edge snap, mount runaway all left the avatar
    // standing in place. Apply the one-tile delta authoritatively; the
    // renderer's smooth-lerp catches up on the next frame.
    const { direction } = decodeMovePlayer(pkt);
    if (world.player) {
      const dir = direction & DIR_MASK;
      const running = (direction & DIR_RUNNING_BIT) !== 0;
      world.player.direction = dir;
      // UO 8-direction deltas live in /shared/directions.js so every
      // walker / AI / renderer / packet handler steps the same way.
      const oldX = world.player.x, oldY = world.player.y, oldMap = world.player.map ?? world.mapId ?? 1;
      world.player.x = (world.player.x | 0) + DIR_DX[dir];
      world.player.y = (world.player.y | 0) + DIR_DY[dir];
      world.reindexMobile?.(world.player, oldX, oldY, oldMap);
      bus.emit('movement:forced', { direction: dir, running });
    } else {
      bus.emit('movement:forced', { direction });
    }
  });

  net.on(0xAB, (pkt) => bus.emit('prompt:text',     decodeTextEntryDialog(pkt)));
  // Audit #42 client P1 #6 — was raw passthrough. CUO
  // `PacketHandlers.cs:3333-3341` reads `senderSerial(u32) + promptId(u64)
  // + ascii text` (text is usually empty — client supplies it). Reply
  // via 0x9A with the same shape + the user's typed text.
  net.on(0x9A, (pkt) => {
    if (pkt.length < 15) { bus.emit('prompt:ascii', pkt); return; }
    const senderSerial = u32(pkt, 3);
    // promptId is u64; split into two u32 to keep JSON-safe.
    const promptIdHi   = u32(pkt, 7);
    const promptIdLo   = u32(pkt, 11);
    let text = '';
    for (let i = 15; i < pkt.length && pkt[i]; i++) text += String.fromCharCode(pkt[i]);
    bus.emit('prompt:ascii', { senderSerial, promptIdHi, promptIdLo, text });
  });
  net.on(0xC2, (pkt) => bus.emit('prompt:unicode',  decodeUnicodePrompt(pkt)));

  net.on(0xAF, (pkt) => {
    const info = decodeDeathAction(pkt);
    // Stamp the dying mobile's facing onto the freshly-spawned corpse so
    // the loot-bag / paperdoll renderer picks the right animation frame.
    const m = world.mobiles.get(info.serial >>> 0);
    if (m) {
      m.dead = true;
      m.hp = 0;
      m.steps.length = 0;
      m._stepsHead = 0;
      m.offsetX = m.offsetY = m.offsetZ = 0;
      m.offsetStartAt = m.offsetEndAt = 0;
      bus.emit('mobile:hp', { serial: m.serial, current: 0, max: Math.max(1, m.hpMax ?? 1) });
    }
    if (m && info.corpseSerial) {
      const dir = (m.direction || 0) & 0x7;
      corpseManager.add(info.corpseSerial, info.serial, dir, !!info.running);
    }
    // Audit #32 P1 #1 — CUO `PacketHandlers.cs:3693` calls
    // `owner.SetAnimation(GetDeathAction(...), repeatCount: 1, ...)`
    // BEFORE the mobile is replaced by the corpse. Emit a death-anim
    // event so mobile-renderer plays Die1/Die2 one-shot; otherwise the
    // mobile teleports straight into the corpse with no fall frames.
    bus.emit('mobile:death-anim', {
      serial: info.serial,
      running: !!info.running,
    });
    bus.emit('mobile:death', info);
    // Audit #35 F8 — CUO `PacketHandlers.cs:3745-3748` honours
    // `Profile.AutoOpenCorpses` here: when the dying mobile is within
    // a couple tiles of the player AND the flag is on, send a
    // double-click on the corpse to auto-open the loot window. Useful
    // for solo PvE where the player wants instant loot. Skip self-
    // death — that opens via 0x2C and is already handled by the
    // corpse manager.
    if (info.corpseSerial && world.player
        && (info.serial >>> 0) !== (world.player.serial >>> 0)
        && profile?.get?.('gameplay.autoOpenCorpses')
        && m && m.map === world.player.map
        && Math.max(Math.abs(m.x - world.player.x), Math.abs(m.y - world.player.y)) <= 3) {
      try { net.send(buildUseReq(info.corpseSerial >>> 0)); }
      catch { /* socket transient */ }
    }
  });
  net.on(0xB7, (_pkt) => { /* help response — not surfaced */ });
  // Audit #41 client P2 #14/#15 — 0xA5 OpenUrl / 0xA6 TipWindow were
  // declared in incoming-table but had no handler → silently dropped.
  net.on(0xA5, (pkt) => {
    // URL ASCII null-terminated after the 3B header (op + u16 len).
    let url = '';
    for (let i = 3; i < pkt.length && pkt[i]; i++) url += String.fromCharCode(pkt[i]);
    if (url) bus.emit('chat:system', { text: `[server URL] ${url}` });
  });
  net.on(0xA6, (pkt) => {
    // Tip window. CUO `PacketHandlers.cs:3473-3477`:
    //   op(1) + len(2) + flag(1) + tipId(u32) + strLen(u16) + ASCII text
    // flag==1 means "cancel current tip" — abort to avoid phantom lines.
    if (pkt.length < 10) return;
    const flag = pkt[3];
    if (flag === 1) { bus.emit('tip:cancel', {}); return; }
    const strLen = (pkt[8] << 8) | pkt[9];
    let text = '';
    for (let i = 10; i < pkt.length && i < 10 + strLen && pkt[i]; i++) {
      text += String.fromCharCode(pkt[i]);
    }
    if (text) bus.emit('chat:system', { text: `[tip] ${text}` });
  });
  // 0x3B CloseVendorInterface — server-initiated vendor-shop close.
  // Audit #46 P1#5 — was mislabelled in incoming-table.js as 'BuyList'.
  net.on(0x3B, (pkt) => {
    if (pkt.length < 7) return;
    const serial = ((pkt[3] << 24) | (pkt[4] << 16) | (pkt[5] << 8) | pkt[6]) >>> 0;
    bus.emit('shop:close', { serial });
  });
  // 0x85 DeleteCharacterAck — server reply to delete request (1B status).
  net.on(0x85, (pkt) => {
    if (pkt.length < 2) return;
    bus.emit('char:delete-ack', { status: pkt[1] | 0 });
  });
  // 0xFD LoginDelay — server tells login screen to count down a delay.
  net.on(0xFD, (pkt) => {
    if (pkt.length < 2) return;
    bus.emit('login:delay', { seconds: pkt[1] | 0 });
  });
  // Audit #41 client P2 #16 — 0x76 NewSubServer carries player coords +
  // mapId on facet swap. Without a handler, `world.mapId` stays stale
  // until the next 0x77/0x78 — causes minimap blink + region miss.
  net.on(0x76, (pkt) => {
    // Layout: op(1) + x(u16) + y(u16) + z(u16) → mapId(u8) at offset 7,
    // then padding (3 u16 = 6 bytes) + width(u16) + height(u16) = 16B.
    // Audit #46 P1#2 — was reading offset 15 (= second byte of height).
    if (pkt.length < 16) return;
    const mapId = pkt[7] | 0;
    if (mapId >= 0 && mapId <= 5) {
      world.mapId = mapId;
      // GameScene owns the asynchronous asset switch. Emitting only the
      // renderer invalidation here reset chunks while AssetManager still
      // pointed at the prior facet, briefly painting the wrong world.
      bus.emit('player:map', { mapId });
    }
  });
  net.on(0xB8, (pkt) => bus.emit('profile:open',    decodeCharacterProfile(pkt)));
  net.on(0xBA, (pkt) => bus.emit('quest:arrow',     decodeQuestArrow(pkt)));
  // Audit #43 client P1 #11 — 0xCB is ServUO `GlobalQueCount` (help-queue
  // position), NOT a gold reward (CUO's handler is an empty stub). Was:
  // every help-ticket emitted a fake `[reward] +N gold` journal line.
  // Surface to journal as the actual semantic.
  net.on(0xCB, (pkt) => {
    const info = decodeGoldReward(pkt);     // returns { amount } (= queue position)
    if (info && Number.isFinite(info.amount)) {
      bus.emit('help:queue-position', { position: info.amount });
      bus.emit('chat:system', { text: `You are #${info.amount} in line for help.` });
    }
  });
  net.on(0xC4, (pkt) => {
    const info = decodeSemivisible(pkt);
    bus.emit('mobile:visibility', info);
    // Client perf round 2 #2: bus event had no consumer — the renderer
    // already dims `mob.hidden` so wiring the flag up makes the
    // server-initiated visibility toggle take effect immediately.
    const m = world.mobiles.get(info.serial >>> 0);
    if (m) m.hidden = !info.visible;
  });

  net.on(0xD2, (pkt) => {
    const info = decodeUpdateObject(pkt);
    const m = world.ensureMobile(info.serial);
    const oldX = m.x, oldY = m.y, oldMap = m.map ?? 1;
    _applyMobilePacketFields(m, info);
    world.reindexMobile?.(m, oldX, oldY, oldMap);
    bus.emit('mobile:update', m);
  });
  net.on(0xD3, (pkt) => {
    const info = decodeCharMoveAnim(pkt);
    bus.emit('anim:custom', info);
  });
  net.on(0xDF, (pkt) => {
    const info = decodeBuffDebuff(pkt);
    bus.emit('buff:icon', info);
    // Actions: 0x00 = remove, 0x01 = add, 0x02 = update (refresh
    // duration / cliloc args on an existing entry). CUO PacketHandlers
    // `.BuffDebuff` routes 0x02 to the same "add" pipeline because the
    // BuffGump's `_add` already replaces by icon id. We were dropping
    // 0x02 entirely → buff timers never updated after the first emit.
    if (info.action === 0x01 || info.action === 0x02) bus.emit('buff:add', info);
    else if (info.action === 0x00)                    bus.emit('buff:remove', info);
  });
  // 0x89 CorpseEquipment — server lists items equipped on a corpse so
  // the loot bag draws the right silhouettes. Without it, opening a
  // freshly-spawned corpse showed an empty bag for ~1s before the
  // 0x3C ContainerContents arrived (CorpseEquipment fills the visual
  // layer order, ContainerContents fills the actual click targets).
  net.on(0x89, (pkt) => {
    const info = decodeCorpseEquipment(pkt);
    // Stamp parent + layer on each referenced item so opening the corpse
    // gump can place the silhouettes on the right slots before the slow
    // 0x3C ContainerContents update arrives.
    const corpse = world.items.get(info.serial);
    if (corpse) {
      corpse._equipLayers = info.items.slice();
      world.batchSpatialMutations?.(() => {
        for (const eq of info.items) {
          const it = world.ensureItem(eq.item);
          const oldParent = it.parent | 0;
          const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1;
          it.parent = info.serial;
          it.layer  = eq.layer;
          world.linkItemParent(it, oldParent);
          world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
        }
      });
    }
    bus.emit('corpse:equipment', info);
  });
  // 0x98 AllNamesAck — reply to our 0x98 NameRequest (single-click on
  // mobs out of speech range, hover labels). Stamp the name onto the
  // mobile so tooltips and overhead labels stop showing the raw serial.
  net.on(0x98, (pkt) => {
    const info = decodeAllNames(pkt);
    const m = world.mobiles.get(info.serial);
    if (m && info.name) m.name = info.name;
    const it = world.items.get(info.serial);
    if (it && info.name) it.name = info.name;
    bus.emit('entity:name', info);
  });
  // 0x95 DyeData — server asks the client to open a dye picker for
  // `serial` with `itemId` graphic. Audit #34 P2 #3: was a bare
  // `bus.emit` with no subscriber. CUO `PacketHandlers.DyeData` opens
  // `ColorPickerGump`; on pick echoes 0x95 back with chosen hue.
  net.on(0x95, async (pkt) => {
    const info = decodeDyeData(pkt);
    bus.emit('dye:open', info);
    try {
      const { pickHue } = await import('../ui/gumps/color-picker-gump.js');
      // User-report — picker starting at hue 2 gave near-invisible
      // tints (hues 1..32 are subtle skin/wood tones, hue 0 = unhued
      // and they all look gray on screen). Open the palette at hue
      // 33 (0x21) which is where the vivid dye-tub block starts in
      // UO — first row is reds/oranges, easy to see any change land.
      const hue = await pickHue({ start: 33, count: 128 });
      if (hue == null) return;            // user cancelled
      net.send(buildHuePickerResponse(info.serial, info.graphic, hue));
    } catch (e) { console.error('[dye] picker flow:', e); }
  });
  // 0xCC DisplayClilocStringAffix — server-localised text + static affix
  // (e.g. "Crafted by …"). We surface it under the same channel as 0xC1
  // and let the journal/chat consumer concatenate args+affix.
  net.on(0xCC, (pkt) => bus.emit('chat:cliloc', decodeClilocAffix(pkt)));
  // 0x23 DragAnimation — pure visual. Audit #34 P2 #7: `fx:drag` had
  // no subscribers. CUO `PacketHandlers.cs:1219 DragAnimation` routes
  // to `world.SpawnEffect(Moving|DragEffect, …)`. Remap onto the
  // existing `fx:graphic` channel so heal-thyself potions, thrown rocks
  // and the arrow-fire-shot lob actually render. The effect-renderer
  // expects the GraphicEffect shape.
  net.on(0x23, (pkt) => {
    const info = decodeDragAnimation(pkt);
    if (!info) return;
    bus.emit('fx:graphic', {
      type: 0,                                       // Moving
      sourceSerial: info.sourceSerial,
      targetSerial: info.targetSerial,
      graphic: info.itemId,
      hue: info.itemHue ?? 0,
      sx: info.sourceX, sy: info.sourceY, sz: info.sourceZ,
      tx: info.targetX, ty: info.targetY, tz: info.targetZ,
      duration: 5, speed: 5,
      fixedDirection: 0, explodes: 0, renderMode: 0,
    });
  });
  // 0x28 EndDraggingItem — server cancels client drag (desync). Emit
  // a clear event the drag manager listens to.
  net.on(0x28, () => bus.emit('drag:cancel-by-server', {}));
  // 0x7C OpenMenu — gray "ServerMenu" choice list. UI subscribes.
  net.on(0x7C, (pkt) => bus.emit('menu:open', decodeOpenMenu(pkt)));
  // 0xB2 ChatMessage — full conference-chat decoder. Audit #46 P1#4 —
  // CUO `PacketHandlers.cs:3811-3920` branches on cmd(u16) at byte 3:
  //   0x03E8 create-conference            0x03E9 destroy-conference
  //   0x03EA leave-conference             0x03EB enter-chat (username prompt)
  //   0x03EC close-chat                   0x03ED already-have-name
  //   0x03EE name-too-long                0x03EF name-conflict
  //   0x03F0 joined-conference (member list follows)
  //   0x03F1 user-joined                  0x03F4 user-left
  //   0x0025 conference message           0x0026 emote
  //   0x0027 system msg in chat
  // Layout per CUO:
  //   op(1) + len(u16) + cmd(u16) + [args depending on cmd]
  // Args generally Unicode-BE null-terminated strings.
  net.on(0xB2, (pkt) => {
    try {
      if (pkt.length < 5) return;
      const cmd = (pkt[3] << 8) | pkt[4];
      // Read a list of null-terminated UTF-16-BE strings starting at off.
      const readUStrings = (off) => {
        const out = [];
        let cur = '';
        while (off + 1 < pkt.length) {
          const code = (pkt[off] << 8) | pkt[off + 1];
          off += 2;
          if (code === 0) { out.push(cur); cur = ''; }
          else cur += String.fromCharCode(code);
        }
        if (cur) out.push(cur);
        return out;
      };
      const args = readUStrings(5);
      switch (cmd) {
        case 0x03E8: bus.emit('chat:conf-create',   { name: args[0] || '' }); break;
        case 0x03E9: bus.emit('chat:conf-destroy',  {}); break;
        case 0x03EA: bus.emit('chat:conf-leave',    {}); break;
        case 0x03EB: bus.emit('chat:enter-username', {}); break;
        case 0x03EC: bus.emit('chat:close',         {}); break;
        case 0x03ED: bus.emit('chat:already-named', {}); break;
        case 0x03EE: bus.emit('chat:name-too-long', {}); break;
        case 0x03EF: bus.emit('chat:name-conflict', {}); break;
        case 0x03F0: bus.emit('chat:joined-conf',   { conf: args[0] || '', members: args.slice(1) }); break;
        case 0x03F1: bus.emit('chat:user-joined',   { user: args[0] || '' }); break;
        case 0x03F4: bus.emit('chat:user-left',     { user: args[0] || '' }); break;
        case 0x0025: bus.emit('chat:message',       { from: args[0] || '', text: args[1] || '' }); break;
        case 0x0026: bus.emit('chat:emote',         { from: args[0] || '', text: args[1] || '' }); break;
        case 0x0027: bus.emit('chat:system-line',   { text: args[0] || '' }); break;
        default:     bus.emit('chat:unknown',       { cmd, args }); break;
      }
    } catch { /* malformed — silent drop */ }
  });
  // 0xE5 / 0xE6 — quest/journey waypoint pin add/remove on the world map.
  net.on(0xE5, (pkt) => bus.emit('waypoint:add',    decodeWaypoint(pkt)));
  net.on(0xE6, (pkt) => {
    // 0xE6 is fixed 5B (op + u32 serial); easier to inline.
    if (pkt.length < 5) return;
    const serial = ((pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]) >>> 0;
    bus.emit('waypoint:remove', { serial });
  });
  net.on(0xF6, (pkt) => {
    const info = decodeBoatMoving(pkt);
    // Audit #38 P1 #2 — a boat is an ITEM (multi), not a mobile. The
    // legacy `ensureMobile` here was a mini-bug — fortunately the
    // boat-moving-manager subscribes to the bus event and reads
    // `world.items.get(serial)`, so this was harmless visual but
    // semantically wrong. Now also update each passenger's coords so
    // they ride the lerp via a delta-update path.
    world.batchSpatialMutations?.(() => {
      const it = world.items?.get?.(info.serial >>> 0);
      if (it) {
        const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1, oldParent = it.parent | 0;
        info.fromX = oldX; info.fromY = oldY; info.fromZ = it.z;
        it.x = info.x; it.y = info.y; it.z = info.z;
        it.facing = info.facing;
        world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
      }
      if (Array.isArray(info.passengers)) {
        for (const p of info.passengers) {
          const mob = world.mobiles?.get?.(p.serial >>> 0);
          if (mob) {
            const oldX = mob.x, oldY = mob.y, oldMap = mob.map ?? 1;
            p.fromX = oldX; p.fromY = oldY; p.fromZ = mob.z;
            p.logicalMoved = true;
            mob.x = p.x; mob.y = p.y; mob.z = p.z;
            world.reindexMobile?.(mob, oldX, oldY, oldMap);
            continue;
          }
          const onDeckItem = world.items?.get?.(p.serial >>> 0);
          if (onDeckItem) {
            const oldX = onDeckItem.x, oldY = onDeckItem.y;
            const oldMap = onDeckItem.map ?? 1, oldParent = onDeckItem.parent | 0;
            p.fromX = oldX; p.fromY = oldY; p.fromZ = onDeckItem.z;
            p.logicalMoved = true;
            onDeckItem.x = p.x; onDeckItem.y = p.y; onDeckItem.z = p.z;
            world.reindexItem?.(onDeckItem, oldX, oldY, oldMap, oldParent);
          }
        }
      }
    });
    bus.emit('boat:moving', info);
  });
  net.on(0x4E, (pkt) => bus.emit('atmosphere:personal-light', decodePersonalLight(pkt)));
  net.on(0xD4, (pkt) => bus.emit('book:open',       decodeOpenBook(pkt)));
  // Audit #42 client P2 #19 — was raw passthrough. CUO
  // `PacketHandlers.cs:2344-2400` walks: serial(u32) + pageCount(u16) +
  // per-page (u16 pageNum + u16 lineCount + per-line ASCII null-term).
  // Was: book gump always rendered with blank pages on server push.
  net.on(0x66, (pkt) => {
    if (pkt.length < 9) { bus.emit('book:data', { raw: pkt }); return; }
    const serial = u32(pkt, 3);
    const pageCount = u16(pkt, 7);
    const pages = [];
    let off = 9;
    for (let p = 0; p < pageCount && off + 4 <= pkt.length; p++) {
      const num   = u16(pkt, off);     off += 2;
      const lines = u16(pkt, off);     off += 2;
      const text  = [];
      for (let l = 0; l < lines && off < pkt.length; l++) {
        let s = '';
        while (off < pkt.length && pkt[off]) { s += String.fromCharCode(pkt[off++]); }
        off++;   // skip null terminator
        text.push(s);
      }
      pages.push({ num, lines: text });
    }
    bus.emit('book:data', { serial, pages });
  });
  net.on(0xD8, (pkt) => {
    // Dense (mode 2) designs derive their grid dimensions from the static
    // foundation multi. Mode 0/1 do not need bounds, but passing them keeps
    // us compatible with both ServUO's compact floor planes and NodeUO's
    // explicit-coordinate encoder.
    const serial = pkt.length >= 9 ? u32(pkt, 5) : 0;
    const foundation = world.items.get(serial);
    const multi = foundation?.multiId != null ? assets.multiTiles(foundation.multiId) : null;
    let bounds = null;
    if (Array.isArray(multi) && multi.length) {
      let minX = Infinity, minY = Infinity, maxY = -Infinity;
      for (const tile of multi) {
        minX = Math.min(minX, tile.x | 0);
        minY = Math.min(minY, tile.y | 0);
        maxY = Math.max(maxY, tile.y | 0);
      }
      if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxY)) {
        bounds = { minX, minY, maxY };
      }
    }
    const session = customHouseSession;
    customHouseDecodeQueue = customHouseDecodeQueue
      .catch(() => {})
      .then(() => decodeCustomHouse(pkt, { bounds }))
      .then((info) => {
        if (session === customHouseSession) bus.emit('house:custom', info);
      })
      .catch((error) => bus.emit('net:decode-error', {
        opcode: 0xD8, message: error?.message ?? String(error),
      }));
  });

  // ---- Messages -----------------------------------------------------------

  net.on(0x03, (pkt) => {
    const info = decodeClientTalk(pkt);
    bus.emit('client-talk', info);
  });

  net.on(0x1C, (pkt) => {
    const m = decodeAsciiMessage(pkt);
    captureNameFromSingleClick(m);
    // CUO sends a 0x03 "ack" reply when the server pings with hue=0xFFFF
    // (SYSTEM "Talk" probe). Without the ack ServUO can rate-limit or
    // disconnect after enough unanswered pings. We answer with an empty
    // ASCIISpeech echo.
    if (m && (m.hue === 0xFFFF || (m.name === 'SYSTEM' && (m.serial === 0xFFFFFFFF >>> 0)))) {
      try { net.send(buildAsciiSpeechAck('', { hue: 0, font: 3 })); }
      catch { /* socket may be transient */ }
    }
    bus.emit('chat:ascii', m);
  });
  net.on(0xAE, (pkt) => {
    const m = decodeUnicodeMessage(pkt);
    captureNameFromSingleClick(m);
    bus.emit('chat:unicode', m);
  });

  // ---- Misc ---------------------------------------------------------------

  net.on(0xBF, (pkt) => {
    const ext = decodeExtendedCommand(pkt);
    bus.emit('ext:command', ext);
    // Fan out named extended commands for decoupled consumers.
    switch (ext.subop) {
      case 0x0001: {
        // FastWalkPrevention init — 6 × u32 BE keys.
        const p = ext.payload;
        if (p.length >= 24) {
          const keys = new Uint32Array(6);
          for (let i = 0; i < 6; i++) keys[i] = u32(p, i * 4);
          bus.emit('fastwalk:init', { keys });
        }
        break;
      }
      case 0x0002: {
        // FastWalkPrevention add — 1 × u32 BE token.
        if (ext.payload.length >= 4) bus.emit('fastwalk:push', { key: u32(ext.payload, 0) });
        break;
      }
      case 0x0004: bus.emit('gump:close-generic',
        { gumpId: u32(ext.payload, 0), buttonId: u32(ext.payload, 4) }); break;
      case 0x0006: bus.emit('party:command',  { payload: ext.payload }); break;
      case 0x0008: bus.emit('player:map',     { mapId: ext.payload[0] | 0 }); break;
      case 0x000C: bus.emit('healthbar:close',{ serial: u32(ext.payload, 0) }); break;
      case 0x0010: {
        // DisplayEquipInfo (CUO PacketHandlers.cs:4213). Payload:
        //   u32 serial, u32 cliloc, then a list of {u16 attr, u16 cliloc}
        //   terminated by an empty entry. We decode the attribute pairs
        //   and emit them as an OPL-style overhead string.
        const p = ext.payload;
        if (p.length >= 8) {
          const serial = u32(p, 0);
          const cliloc = u32(p, 4);
          const attrs = [];
          for (let off = 8; off + 4 <= p.length; off += 4) {
            const attrId = (p[off] << 8) | p[off + 1];
            const attrCl = (p[off + 2] << 8) | p[off + 3];
            if (attrId === 0 && attrCl === 0) break;
            attrs.push({ attrId, cliloc: attrCl });
          }
          bus.emit('item:equipinfo', { serial, cliloc, attrs });
        }
        break;
      }
      case 0x0011: {
        // Audit #46 P3 — CUO `PacketHandlers.cs:4340` is `break;` (nop).
        // Our previous decode invented stat-lock bits + emitted the
        // canonical `mobile:stat-locks` event with payload from random
        // bytes — colliding with the real 0x19 stat-locks broadcast.
        // No-op now: silently consume.
        break;
      }
      case 0x0014: bus.emit('popup:show',     decodeContextMenu(ext.payload)); break;
      // 0xBF 0x16 close-window — payload is `u32 kind, u32 serial`.
      // CUO `PacketHandlers.cs:4358-4388` dispatches by `kind`
      // (1=paperdoll, 2=healthbar, 8=profile, 0x0C=container) and
      // closes the matching gump for the given serial. The previous
      // decode treated the first u32 as the serial and dropped the
      // second word entirely, so server-driven close (bank box on
      // movement, trade gump on cancel) silently no-op'd.
      case 0x0016: bus.emit('gump:close', {
        kind:   u32(ext.payload, 0),
        serial: u32(ext.payload, 4),
      }); break;
      case 0x0018: bus.emit('map:patches',    { payload: ext.payload }); break;
      case 0x0019: {
        // Extended stats. CUO branches by `version`:
        //   0: bonded/dead state, 2: stat locks, 5: static animation frame
        //      or a version-2-compatible payload.
        const p = ext.payload;
        if (p.length >= 5) {
          const version = p[0] | 0;
          const serial = u32(p, 1);
          const setDeadState = (dead) => {
            const mob = world.mobiles.get(serial >>> 0);
            if (mob) mob.dead = !!dead;
            bus.emit('mobile:death-state', { serial, dead: !!dead });
          };
          const emitStatLocks = (bits) => {
            bus.emit('mobile:stat-locks', {
              serial,
              strLock: (bits >> 4) & 0x3,
              dexLock: (bits >> 2) & 0x3,
              intLock:  bits       & 0x3,
            });
          };
          if (version === 0 && p.length >= 6) {
            setDeadState(p[5] !== 0);
          } else if (version === 2 && p.length >= 7) {
            emitStatLocks(p[6] | 0);
          } else if (version === 5 && p.length >= 7) {
            const marker = p[6] | 0;
            if (marker === 0xFF && p.length >= 12) {
              const status = p[7] | 0;
              const animation = ((p[8] << 8) | p[9]) & 0xffff;
              const frame = ((p[10] << 8) | p[11]) & 0xffff;
              if (status === 0 && animation === 0 && frame === 0) {
                setDeadState(p[5] !== 0);
              } else {
                bus.emit('anim:custom', { serial, action: animation, staticFrame: frame });
              }
            } else if ((world.player?.serial >>> 0) === (serial >>> 0)) {
              emitStatLocks(marker);
            }
          }
        }
        bus.emit('mobile:ext-stats', { payload: ext.payload });
        break;
      }
      case 0x001B: {
        // NewSpellbookContent. Payload after the `op + len + sub` header:
        //   u16 unk1 (=0x0001), u32 serial, u16 offset (1=Magery,
        //   101=Necromancy...), u64 content (BE) — bit n = spell n+offset
        //   is known. Used to render the spellbook gump instead of a
        //   generic container window when the player double-clicks
        //   their book.
        const p = ext.payload;
        if (p.length >= 16) {
          const serial = u32(p, 2);
          const offset = (p[6] << 8) | p[7];
          const hi = u32(p, 8);
          const lo = u32(p, 12);
          bus.emit('spellbook:content', { serial, offset, hi, lo });
        }
        break;
      }
      case 0x001D: bus.emit('house:revision',   { payload: ext.payload }); break;
      case 0x0021: bus.emit('combat:abilities-clear', {}); break;
      // Audit #30 P1 #1 — 0x22 DisplayDamage. CUO `PacketHandlers.cs` skips a
      // leading filler byte, then reads u32 serial + u8 amount. Was offset 0
      // → serial low-byte became "amount", damage floated over wrong mob.
      case 0x0022: _emitCombatDamage({ serial: u32(ext.payload, 1), amount: ext.payload[5] | 0 }); break;
      // Audit #30 P1 #2 — 0x25 SetSpellMode. CUO reads ushort spellId + bool.
      // Was `u32 & 0xffff` (big-endian) which kept the LOW 16 bits — bytes
      // 2-3, colliding with the `active` byte. Active icon highlight never
      // painted for the right spell.
      case 0x0025: bus.emit('spell:toggle',   { spellId: (ext.payload[0] << 8) | ext.payload[1],
                                                active:  ext.payload[2] !== 0 }); break;
      case 0x0026: bus.emit('player:speed-mode', { mode: ext.payload[0] | 0 }); break;
      case 0x0020: {
        // CustomHouseInteraction — CUO `PacketHandlers.cs:4584` reads
        //   u32 serial, u8 type, u16 graphic, u16 x, u16 y, i8 z
        // and dispatches by type: 1 update, 2 remove, 3 multi-pos, 4
        // begin (opens HouseCustomizationGump), 5 end (closes it).
        const p = ext.payload;
        if (p.length >= 12) {
          const serial = u32(p, 0);
          const type   = p[4];
          const graphic = (p[5] << 8) | p[6];
          const x = (p[7] << 8) | p[8];
          const y = (p[9] << 8) | p[10];
          let z = p[11]; if (z >= 128) z -= 256;
          const info = { serial, type, graphic, x, y, z };
          bus.emit('house:custom-interact', info);
          if (type === 4) bus.emit('house:custom-start', info);
          if (type === 5) bus.emit('house:custom-end', info);
        }
        break;
      }
      case 0x002A: {
        // ChangeRace — opens the RaceChangeGump.  Payload: u8 isFemale + u8 race.
        const p = ext.payload;
        if (p.length >= 2) bus.emit('race:change-prompt', { female: !!p[0], race: p[1] | 0 });
        break;
      }
      case 0x002B: {
        // SetMobileAnimation — `u16 serial-low16 + u8 animId + u8 frame`.
        // ServUO uses this to set an authoritative frozen frame (e.g.
        // sit-on-chair, lying-dead). We forward it to mobile state via
        // the animation bus event; renderer reads `_overrideFrame` / `_overrideAnim`.
        const p = ext.payload;
        if (p.length >= 4) {
          const lowSerial = (p[0] << 8) | p[1];
          bus.emit('mobile:set-frame', {
            serialLow: lowSerial,
            animId: p[2] | 0,
            frame:  p[3] | 0,
          });
        }
        break;
      }
      // Audit rev.4 P3 — rare AOS subops that CUO ships as stubs. We
      // log them at trace level so a future shard implementing them
      // can see they arrived; the generic `ext:command` event above
      // also fires so subscribers can opt in.
      case 0x0003: /* PartyMessageInternal — superseded by 0x06 */
      case 0x0005: /* CloseStatusBar */
      case 0x0007: /* Mahjong (legacy, removed in 7.x) */
      case 0x000B: /* MobileStatusUpdateAOS — unused on ServUO */
      case 0x000D: /* DisplayCharacterDialog */
      case 0x000E: /* ClientLanguage echo */
      case 0x000F: /* CloseStatusBarRequest */
      case 0x0024: /* UnknownAOS — appears in CUO PacketsTable as stub */
        bus.emit('ext:rare', { subop: ext.subop, length: ext.payload?.length ?? 0 });
        break;
      default: /* surfaced via the generic 'ext:command' bus event */ break;
    }
  });

  // ---- Status / health bar / death / trade / attack / logout -----------

  net.on(0x11, (pkt) => {
    const info = decodeMobileStatus(pkt);
    if (info?.malformed) return;
    const m = world.mobiles.get(info.serial >>> 0);
    if (m) {
      // Update every known scalar — caller picks the fields they want
      // from the bus event but `m.*` should match server truth.
      for (const k of ['name','hp','hpMax','sex','str','dex','int','stam','stamMax',
                       'mana','manaMax','gold','ar','weight','weightMax','race',
                       'statCap','followers','followersMax','fireResist','coldResist',
                       'poisonResist','energyResist','physResist','luck','dmgMin','dmgMax',
                       'tithingPoints']) {
        if (info[k] !== undefined) m[k] = info[k];
      }
    }
    bus.emit('mobile:status', info);
  });

  // Healthbar update: ServUO emits both 0x16 (HealthbarPoison/Yellow, AOS
  // legacy) and 0x17 (NewHealthbarUpdate, SA+ unified). Both share the
  // same wire layout `serial(4) + count(2) + count × { type(2), enabled(1) }`
  // per CUO `PacketHandlers.cs` Handlers.Add(0x16) + Handlers.Add(0x17).
  // Audit #43 client P1 #16 already widened 0x16's framer entry to VAR;
  // this handler wires it so the poison/yellow badge actually flips.
  const onHealthbar = (pkt) => {
    const ev = decodeNewHealthbarUpdate(pkt);
    const m = world.mobiles.get(ev.serial >>> 0);
    if (m) {
      // type 1 = poison, type 2 = yellow hits (invul/SA). Field is `type`
      // not `color` (audit #43 P1 #8). No `level` on the wire.
      for (const s of ev.states) {
        if (s.type === 1) {
          m.poisoned   = s.enabled;
          m._saPoison  = s.enabled;
          if (!s.enabled) m.poisonLevel = 0;
        } else if (s.type === 2) {
          m.yellowHits = s.enabled;
        }
      }
    }
    bus.emit('mobile:healthbar', ev);
  };
  net.on(0x16, onHealthbar);
  net.on(0x17, onHealthbar);

  net.on(0x2C, (pkt) => {
    const info = decodeDeathStatus(pkt);
    bus.emit('player:death-status', info);
    // Audit #35 F4 — CUO `PacketHandlers.DeathScreen` on `action !== 1`:
    // resets weather, plays DeathMusic (id 42, looped), and requests
    // war-mode off. Was: bare bus emit only. Without this, ghost walked
    // through ongoing rain + region music kept playing + warmode flag
    // stayed lit (defender could swing as a ghost on next reconnect).
    if (info.action !== 0x01) {
      bus.emit('atmosphere:weather', { kind: 0xFE, particles: 0, temperature: 0 });
      bus.emit('atmosphere:music', { musicId: 42 });
      if (world.player?.warMode) {
        try {
          net.send(buildWarMode(false));
        } catch { /* module not loaded */ }
      }
    }
  });

  net.on(0x6F, (pkt) => bus.emit('trade:event', decodeSecureTrade(pkt)));

  // 0xAA AttackReply — server confirms our new attack focus (serial=0
  // clears it). Drive combat:target + combat:state from here. Combat
  // state stays "in combat" while we're getting hit or attacking; idles
  // out after 8s of silence. CUO uses the same heuristic on its side.
  let _combatActive = false;
  let _combatIdleTimer = null;
  const _markInCombat = () => {
    if (_combatIdleTimer) clearTimeout(_combatIdleTimer);
    if (!_combatActive) {
      _combatActive = true;
      bus.emit('combat:state', { inCombat: true });
    }
    _combatIdleTimer = setTimeout(() => {
      _combatActive = false;
      _combatIdleTimer = null;
      bus.emit('combat:state', { inCombat: false });
    }, 8000);
  };
  net.on(0xAA, (pkt) => {
    const info = decodeAttackReply(pkt);
    bus.emit('combat:target', info);
    if (info.serial) _markInCombat();
    else if (_combatActive) {
      // Explicit "clear attack" — drop combat-state immediately, audio
      // restores its prior track on the next tick.
      if (_combatIdleTimer) clearTimeout(_combatIdleTimer);
      _combatIdleTimer = null;
      _combatActive = false;
      bus.emit('combat:state', { inCombat: false });
    }
  });
  // Damage taken / dealt also extends the combat window so missing the
  // 0xAA (e.g. attacker switched) doesn't strand us in "peaceful music".
  bus.on('combat:damage', () => { if (world.player) _markInCombat(); });

  net.on(0xD1, (pkt) => bus.emit('player:logout-resp', decodeLogoutResponse(pkt)));

  // Bulletin board (0x71). Audit #46 P1#3 — full rewrite per CUO
  // `PacketHandlers.cs:2522-2640`. Was reading u16 lengths and wrong
  // sub-0 layout → no posts ever displayed.
  //
  // Layout per CUO:
  //   sub=0x00 (board-open):  boardSerial(u32) + ASCII 22-byte board name
  //   sub=0x01 (post-summary): boardSerial(u32) + postSerial(u32) +
  //                            parentSerial(u32) + posterLen(u8) + poster
  //                          + subjLen(u8) + subject + dateLen(u8) + date
  //   sub=0x02 (post-body):    same + skip4 + linecount(u8) + per-line
  //                            { lineLen(u8) + ASCII text }
  net.on(0x71, (pkt) => {
    if (pkt.length < 4) return;
    const sub = pkt[3];
    const readU32 = (o) => ((pkt[o] << 24) | (pkt[o+1] << 16) | (pkt[o+2] << 8) | pkt[o+3]) >>> 0;
    const readAsciiFixed = (o, n) => {
      let s = '';
      for (let i = 0; i < n && o + i < pkt.length && pkt[o+i]; i++) {
        s += String.fromCharCode(pkt[o+i]);
      }
      return s;
    };
    const readAsciiLen = (o, n) => {
      let s = '';
      for (let i = 0; i < n && o + i < pkt.length; i++) {
        const b = pkt[o+i];
        if (b === 0) break;
        s += String.fromCharCode(b);
      }
      return s;
    };
    if (sub === 0x00) {
      if (pkt.length < 8 + 22) return;
      const boardSerial = readU32(4);
      const name = readAsciiFixed(8, 22);
      bus.emit('bbs:open', { boardSerial, name });
    } else if (sub === 0x01) {
      if (pkt.length < 4 + 4 + 4 + 4 + 1) return;
      const boardSerial   = readU32(4);
      const postSerial    = readU32(8);
      const parentSerial  = readU32(12);
      let off = 16;
      const posterLen = pkt[off++] | 0;
      const poster = readAsciiLen(off, posterLen); off += posterLen;
      const subjLen = pkt[off++] | 0;
      const subject = readAsciiLen(off, subjLen); off += subjLen;
      const dateLen = pkt[off++] | 0;
      const date = readAsciiLen(off, dateLen); off += dateLen;
      bus.emit('bbs:summary', { boardSerial, postSerial, parentSerial, poster, subject, date });
    } else if (sub === 0x02) {
      if (pkt.length < 4 + 4 + 4 + 4 + 1) return;
      const boardSerial   = readU32(4);
      const postSerial    = readU32(8);
      const parentSerial  = readU32(12);
      let off = 16;
      const posterLen = pkt[off++] | 0;
      const poster = readAsciiLen(off, posterLen); off += posterLen;
      const subjLen = pkt[off++] | 0;
      const subject = readAsciiLen(off, subjLen); off += subjLen;
      const dateLen = pkt[off++] | 0;
      const date = readAsciiLen(off, dateLen); off += dateLen;
      off += 4; // skip 4 unused bytes (CUO `pvSrc.Skip(4)`)
      const lineCount = pkt[off++] | 0;
      const lines = [];
      for (let i = 0; i < lineCount && off < pkt.length; i++) {
        const lineLen = pkt[off++] | 0;
        if (lineLen === 0) { lines.push(''); continue; }
        lines.push(readAsciiLen(off, lineLen));
        off += lineLen;
      }
      bus.emit('bbs:body', { boardSerial, postSerial, parentSerial, poster, subject, date, lines });
    }
  });

  // Mahjong (0xDA) — generic state push from server. Payload schema is
  // open-ended; we just surface the raw bytes so the gump can decode.
  net.on(0xDA, (pkt) => {
    if (pkt.length < 8) return;
    const sub = pkt[3];
    const gameSerial = ((pkt[4] << 24) | (pkt[5] << 16) | (pkt[6] << 8) | pkt[7]) >>> 0;
    bus.emit('mahjong:state', { gameSerial, sub, raw: pkt.subarray(8), tiles: [] });
  });
  net.on(0x73, (pkt) => bus.emit('net:ping',    decodePing(pkt))); // keep-alive echo

  // ---- Server-driven gumps ------------------------------------------------

  net.on(0xB0, (pkt) => {
    try { bus.emit('gump:open', decodeOpenGump(pkt)); }
    catch (e) { console.error('[net] decodeOpenGump failed', e); }
  });
  net.on(0xDD, (pkt) => {
    const epoch = net.sessionEpoch.capture();
    decodeCompressedGump(pkt)
      .then((info) => {
        if (net.sessionEpoch.valid(epoch)) bus.emit('gump:open', info);
      })
      .catch((e) => console.error('[net] decodeCompressedGump failed', e));
  });

  // ---- Hardcoded gumps ----------------------------------------------------

  net.on(0x88, (pkt) => bus.emit('paperdoll:open', decodeOpenPaperdoll(pkt)));

  net.on(0x24, (pkt) => bus.emit('container:open', decodeOpenContainer(pkt)));
  net.on(0x74, (pkt) => {
    const info = decodeBuyList(pkt);
    // 0x74 carries only name+price. Standard UO sends a 0x3C stock
    // container immediately beforehand; merge by its authored grid/order so
    // the shop gets real serials, artwork, hue and authoritative quantities.
    const stock = [...(world.childrenOf?.(info.vendor) ?? [])]
      .sort((a, b) => (a.gridLocation ?? 0) - (b.gridLocation ?? 0));
    info.items = info.items.map((line, index) => ({ ...stock[index], ...line }));
    bus.emit('shop:buy', info);
  });
  net.on(0x9E, (pkt) => bus.emit('shop:sell',      decodeSellList(pkt)));

  net.on(0x6C, (pkt) => bus.emit('target:cursor',  decodeTargetCursor(pkt)));

  // ---- Multi placement (house/boat/ship) ---------------------------------
  net.on(0x99, (pkt) => bus.emit('target:multi',  decodeMultiPlacement(pkt)));

  net.on(0xC1, (pkt) => bus.emit('chat:cliloc',    decodeClilocMessage(pkt)));

  net.on(0x3C, (pkt) => {
    const { items } = decodeContainerContents(pkt);
    // Group by parent so multiple-container snapshots dispatch as a unit.
    /** @type {Map<number, any[]>} */
    const byParent = new Map();
    for (const it of items) {
      let arr = byParent.get(it.parent >>> 0);
      if (!arr) { arr = []; byParent.set(it.parent >>> 0, arr); }
      arr.push(it);
    }
    for (const [containerSerial, itemsForParent] of byParent) {
      const committed = world.replaceContainerContents(containerSerial, itemsForParent);
      if (committed.ok) bus.emit('container:contents', { containerSerial, items: itemsForParent });
      else console.warn('[world] rejected container snapshot', containerSerial, committed.reason);
    }
  });

  net.on(0x25, (pkt) => {
    const info = decodeContainerContentUpdate(pkt);
    // Mutate world.items so future hover / lift / re-open all see the
    // confirmed grid position. Without this update the gump stayed
    // visually correct but world.items[serial].gridX/gridY were stale,
    // and re-opening the bag (or the next 0x3C contents push) snapped
    // the item back to its old corner. Mirrors how 0x1A WorldItem
    // already updates world.items in-place above.
    const existing = world.items.get(info.serial >>> 0);
    const newParent = (info.parent ?? 0) >>> 0;
    if (existing) {
      const oldParent = (existing.parent ?? 0) >>> 0;
      const oldX = existing.x, oldY = existing.y, oldMap = existing.map ?? 1;
      const prevHue   = existing.hue;
      existing.itemId = info.itemId | 0;
      existing.amount = info.amount | 0;
      existing.hue = info.hue | 0;
      existing.parent = newParent;
      existing.gridX = info.gridX | 0;
      existing.gridY = info.gridY | 0;
      existing.layer = info.layer ?? existing.layer ?? 0;
      if (oldParent !== newParent) world.linkItemParent(existing, oldParent);
      world.reindexItem?.(existing, oldX, oldY, oldMap, oldParent);
      if (prevHue !== info.hue && net.debugHues) {
        console.log('[hue] 0x25 containerContent serial=0x%s hue %s → %s parent=0x%s',
          info.serial.toString(16), prevHue, info.hue, newParent.toString(16));
      }
    } else {
      // Item not seen before — synthesise a minimal record so re-open
      // and lift work without waiting for a follow-up 0x1A.
      const fresh = world.ensureItem(info.serial);
      const oldParent = (fresh.parent ?? 0) >>> 0;
      const oldX = fresh.x, oldY = fresh.y, oldMap = fresh.map ?? 1;
      fresh.itemId = info.itemId | 0;
      fresh.amount = info.amount | 0;
      fresh.hue = info.hue | 0;
      fresh.parent = newParent;
      fresh.gridX = info.gridX | 0;
      fresh.gridY = info.gridY | 0;
      fresh.layer = info.layer ?? 0;
      fresh.x = fresh.x ?? 0;
      fresh.y = fresh.y ?? 0;
      fresh.z = fresh.z ?? 0;
      fresh.map = fresh.map ?? 0;
      fresh.direction = fresh.direction ?? 0;
      world.linkItemParent(fresh, 0);
      world.reindexItem?.(fresh, oldX, oldY, oldMap, oldParent);
    }
    world.validateGraph({ repair: true });
    bus.emit('container:item-update', info);
  });

  net.on(0x27, (pkt) => {
    // PickUpRejected — server refused our 0x07 lift. Snap back.
    bus.emit('drag:rejected-by-server', { reason: pkt[1] });
  });
  net.on(0x29, () => {
    // DropApproved — server accepted our 0x08/0x13. Nothing to do; we already
    // moved local state optimistically.
    bus.emit('drag:approved');
  });

  // Audit #36 P2 #7 — track per-skill `realValue` so the 0x3A handler
  // can compute a delta and post the CUO "Your X has increased by 0.1"
  // journal line gated on `profile.skills.showChange`.
  const _skillCache = new Map();
  net.on(0x3A, (pkt) => {
    const info = decodeSkills(pkt);
    const SKILL_NAMES = [
      'Alchemy','Anatomy','Animal Lore','Item Identification','Arms Lore',
      'Parrying','Begging','Blacksmithy','Bowcraft/Fletching','Peacemaking',
      'Camping','Carpentry','Cartography','Cooking','Detect Hidden',
      'Discordance','Evaluating Intelligence','Healing','Fishing','Forensic Eval',
      'Herding','Hiding','Provocation','Inscription','Lockpicking',
      'Magery','Magic Resist','Tactics','Snooping','Musicianship',
      'Poisoning','Archery','Spirit Speak','Stealing','Tailoring',
      'Animal Taming','Taste Identification','Tinkering','Tracking','Veterinary',
      'Swordsmanship','Mace Fighting','Fencing','Wrestling','Lumberjacking',
      'Mining','Meditation','Stealth','Remove Trap','Necromancy',
      'Focus','Chivalry','Bushido','Ninjitsu','Spellweaving',
      'Mysticism','Imbuing','Throwing',
    ];
    const showChange = profile.get('skills.showChange') !== false;
    const deltaFixed = profile.get('skills.deltaMsgFixed') ?? 1;
    if (info.type === 0xFF || info.type === 0xDF) {
      // single-skill update
      if (info.skills[0]) {
        const s = info.skills[0];
        // Audit #36 P2 #7 (rev. 2026-05-17) — show the old → new value pair. The
        // earlier format reported a delta only ("increased by 0.1.
        // It is now 12.5") which the user found unhelpful for tracking
        // progress jumps. Still gated by `profile.skills.showChange`
        // (default ON) so power users who want a quiet log can hide
        // them. Wire is 0-indexed after `decodeSkills`'s `id - 1` so
        // SKILL_NAMES[s.id] resolves the canonical name.
        const prev = _skillCache.get(s.id | 0);
        const cur  = s.value | 0;
        if (showChange && prev != null && Math.abs(cur - prev) >= (deltaFixed | 0)) {
          const sign = cur > prev ? 'increased' : 'decreased';
          const name = SKILL_NAMES[s.id | 0] ?? `Skill ${s.id}`;
          const fromS = (prev / 10).toFixed(1);
          const toS   = (cur  / 10).toFixed(1);
          bus.emit('chat:system', {
            text: `Your ${name} skill ${sign}: ${fromS} → ${toS}.`,
            hue: 0x58,
          });
        }
        _skillCache.set(s.id | 0, s.value | 0);
        bus.emit('skills:update', { skill: s });
      }
    } else {
      // List update — repopulate cache without journal noise.
      for (const s of info.skills) _skillCache.set(s.id | 0, s.value | 0);
      bus.emit('skills:list', { skills: info.skills });
    }
  });
}
