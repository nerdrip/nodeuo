// Corpses — when a mobile dies, we spawn a corpse container (itemId 0x2006)
// at the mobile's position, re-parent their equipment into it, and play the
// 0x2C death-ack packet on the corpse's owning client (if any).
//
// This module is intentionally light: it just produces a corpse item. Loot
// mechanics are the same as any other container (0x3C/0x25 packets already
// handle drag-out).

import { createItem, destroyItem, containerChildren } from './world/items.js';
import * as itemsMod from './world/items.js';
import { dispatchItemEvent } from './world/item-scripts.js';
import { removeEntity, graphicalEffect, EffectKind, deathStatus, deathAction, mobileUpdate, mobileIncoming, healthUpdate, mobileMoving, playerAnimation, playSound, worldItemSA } from '@uo/protocol';
import { recordKill } from './notoriety.js';
import { recordFactionKill } from './systems/pvp/factions.js';
import { awardVirtue, valorForKill } from './systems/rewards/virtues.js';
import { awardPetXp, petXpForKill } from './systems/pets/pet-training.js';
import { collectInsuredItems, chargeInsurance } from './systems/economy/insurance.js';
import { clearDamageEntries, getTopDamager } from './world/damage-tracking.js';
import { effectiveSkill, normalizeSkillValue } from './combat-formulas.js';
import { dispatch as dispatchXmlAttachment } from './systems/world/xml-attachments.js';

/** @type {((kind:string) => any) | null} */
let _monstersGetter = null;
/** Wired by main.js to expose the monsters registry to corpse hooks. */
export function setMonstersGetter(fn) { _monstersGetter = fn; }

const CORPSE_ITEM_ID = 0x2006;
const GHOST_BODY_MALE = 0x0192;
const GHOST_BODY_FEMALE = 0x0193;

export function trackCorpse(world, corpse) {
  if (!world || !corpse?.serial) return;
  world._corpses ||= new Set();
  world._corpses.add(corpse.serial >>> 0);
}

export function untrackCorpse(world, corpseOrSerial) {
  const serial = typeof corpseOrSerial === 'number'
    ? corpseOrSerial >>> 0
    : corpseOrSerial?.serial >>> 0;
  if (!serial) return;
  world?._corpses?.delete?.(serial);
}

function ensureCorpseIndex(world) {
  world._corpses ||= new Set();
  if (world._corpseIndexReady) return world._corpses;
  for (const it of world.items?.values?.() ?? []) {
    if ((it.itemId | 0) === CORPSE_ITEM_ID) world._corpses.add(it.serial >>> 0);
  }
  world._corpseIndexReady = true;
  return world._corpses;
}

function findStaffOrb(world, mob) {
  if (!world || !mob?.serial) return null;
  const isOrb = (item) => item?.script === 'staff-orb' || item?.servuoClass === 'StaffOrb';
  for (const item of itemsMod.childrenOf(world, mob.serial) ?? []) {
    if (isOrb(item)) return item;
    if (!item?.serial) continue;
    for (const nested of itemsMod.containerChildrenRecursive?.(world, item.serial) ?? []) {
      if (isOrb(nested)) return nested;
    }
  }
  return null;
}

/** @type {import('./world/loot.js').LootRegistry | null} */
let lootRegistry = null;

/** Set by main.js at boot so dropLoot can resolve named loot tables. */
export function setLootRegistry(registry) { lootRegistry = registry; }

/**
 * Post-kill hook chain. Scripts (quest tracking, achievements, etc.)
 * register a `(world, victim, killer) => void` and it runs AFTER the
 * core kill bookkeeping (corpse spawn, loot drop, notoriety bump).
 *
 * Why this exists: scripts/quests.js used to do
 * `api.corpse.killMobile = wrapped` to intercept kills, but ES module
 * exports are read-only — the assignment threw "Cannot assign to read
 * only property 'killMobile' of object '[object Module]'" at script
 * init and the entire quest system silently dropped. Same failure
 * class as the templates.useItem monkey-patch fixed in PHASE LA;
 * same fix shape (registration API instead of property reassignment).
 */
const _killHooks = [];
export function addKillHook(fn) {
  if (typeof fn !== 'function') return () => false;
  _killHooks.push(fn);
  let active = true;
  return () => {
    if (!active) return false;
    active = false;
    const index = _killHooks.indexOf(fn);
    if (index >= 0) _killHooks.splice(index, 1);
    return index >= 0;
  };
}
export function clearKillHooks() { _killHooks.length = 0; }

/** @typedef {import('./world/world.js').World} World */

/**
 * @param {World} world
 * @param {import('./world/world.js').Mobile} mob          victim
 * @param {import('./world/world.js').Mobile} [killer]     attacker, when known
 * @returns {import('./world/items.js').Item} corpse item
 */
export function killMobile(world, mob, killer = null) {
  // Death delivery can race between combat, poison and scripted damage.
  // Once a player is a ghost (or an NPC has already left the world), a
  // repeated callback must not create another corpse or award kill hooks.
  if (!mob || mob.ghost || !world?.mobiles?.has?.(mob.serial)) return null;
  // Temporary summons return directly to the ether. Creating a corpse here
  // was doubly wrong: it exposed an empty loot container and kept the
  // summoner's follower slots occupied until the later expiry sweep.
  if (mob.summoned || mob.summonedUntil || mob.summonedBy) {
    mob.hp = 0;
    const master = world.mobiles.get((mob.controlMaster || mob.summonedBy) >>> 0);
    if (typeof world.releaseFollowerSlots === 'function') world.releaseFollowerSlots(mob);
    else {
      const slots = mob._followerCost | 0;
      if (master && slots > 0) master.followers = Math.max(0, (master.followers | 0) - slots);
      mob._followerCost = 0;
    }
    world._summons?.delete?.(mob.serial >>> 0);
    broadcastInRange(world, mob, (client) => client.send(removeEntity(mob.serial)));
    world.destroyMobile?.(mob.serial);
    master?.client?.sendSystemMessage?.(`Your ${mob.name ?? 'summon'} returns to the ether.`);
    return null;
  }
  // Audit #37 P1 #4 — ServUO `GiftOfLifeSpell.HandleDeath_OnCallback`
  // intercepts death and auto-resurrects the buffed mobile, restoring
  // HP via `hitsScalar = spellweaving/240 + focusLevel/100`. Was
  // entirely missing — the flag was set by the spell but no killMobile
  // consumer ever read it.
  if (mob && mob.giftOfLifeArmed && (mob.giftOfLifeUntil ?? 0) > Date.now()) {
    mob.giftOfLifeArmed = false;
    mob.giftOfLifeUntil = 0;
    // Restore HP based on the original caster's Spellweaving + focus.
    const sw    = normalizeSkillValue(mob._giftOfLife_sw ?? effectiveSkill(mob, 55));
    const focus = (mob._giftOfLife_focus ?? 0);
    const scalar = Math.max(0.1, Math.min(1, sw / 240 + focus / 100));
    mob.hp = Math.max(1, Math.floor((mob.hpMax ?? 50) * scalar));
    mob.ghost = false;
    if (mob.client?.sendSystemMessage) {
      mob.client.sendSystemMessage('The Gift of Life restores you.');
    }
    return null;          // skip corpse spawn / loot drop entirely
  }
  if (mob?.client && !mob._staffOrbAutoResPending) {
    const orb = findStaffOrb(world, mob);
    if (orb?.staffOrbAutoRes && (!orb.staffOrbOwnerSerial || (orb.staffOrbOwnerSerial >>> 0) === (mob.serial >>> 0))) {
      mob._staffOrbAutoResPending = Date.now() + 5_000;
      setTimeout(() => {
        mob._staffOrbAutoResPending = 0;
        if (!world?.mobiles?.has?.(mob.serial)) return;
        try { resurrectMobile(world, mob, mob); } catch { /* advisory */ }
        mob.accessLevel = orb.staffOrbStaffLevel ?? mob.accessLevel ?? 'GM';
        mob.blessed = true;
        mob.client?.sendSystemMessage?.("...How in the hell did you manage to die? You're a staff member!");
      }, 5_000).unref?.();
    }
  }
  // Server parity #7: huntmaster-challenge submit. Was wired in the
  // system file but no kill-path ever called `submitTrophy`. Leaderboard
  // stayed empty regardless of kills. Submit on every player-driven
  // kill of a non-player creature. `world._huntmasterSubmit` is set by
  // main.js (late-bound to avoid the cyclic import here).
  if (killer?.client && mob && !mob.client) {
    try { world?._huntmasterSubmit?.(world, killer, mob); }
    catch (e) { console.error('[corpse] huntmaster submitTrophy threw:', e); }
  }
  // Bug-hunt #8 #12 + #10: clear DoT timers + status effects on death.
  // Status effects (Bless/Curse/Strangle) survived through ghost mode
  // for players and `_bleedUntil`/`_burnUntil` kept ticking on the
  // corpse owner with `hp > 0` check still positive between death
  // delivery and the actual hp=0 stamp. Wipe the slate.
  if (mob) {
    mob._bleedUntil = 0;
    mob._burnUntil = 0;
    mob._poisonUntil = 0;
    mob._poisonLevel = 0;
    mob._mortalStrikeUntil = 0;
    mob._paralyzedUntil = 0;
    mob._sufferingUntil = 0;
    mob._discordedUntil = 0;
    mob._peacefulUntil = 0;
    mob._provokedUntil = 0;
    mob._provokedTarget = 0;
    mob._spiritSpeakUntil = 0;
    mob.canHearGhosts = false;
    // Audit #33 P1 #4 — partner-mob sweep. ServUO clears Combatant on
    // the surviving provoke partner the next AI think; we don't have
    // that hook, so the AI loop happily re-pinned `combatant = stale
    // serial` for 60 s, making the survivor chase a ghost instead of
    // engaging real threats. Walk the world ONCE and clear pointers
    // back to this dead serial. Cheap: most NPCs aren't provoked, so
    // the early skip on `_provokedTarget|0 !== mob.serial` is a noop.
    const deadSerial = mob.serial | 0;
    if (world?.mobiles?.values) {
      for (const m of world.mobiles.values()) {
        if ((m._provokedTarget | 0) !== deadSerial) continue;
        m._provokedTarget = 0;
        m._provokedUntil = 0;
      }
    }
    mob._charmedUntil = 0;
    mob._charmedBy = 0;
    if (Array.isArray(mob.effects)) mob.effects.length = 0;
    // BH #13 B7 — clear any in-flight cast so the runEffect setTimeout
    // doesn't fire `def.effect(ctx)` on the now-dead caster (caster
    // lifedrain → write to corpse). Also drop the mana-refund stash so
    // a fresh cast can't reuse it.
    if (mob._castTimer) {
      try { clearTimeout(mob._castTimer); } catch { /* ignore */ }
      mob._castTimer = null;
    }
    mob._castDef = null;
    mob._castManaRefund = 0;
  }
  // Achievements bookkeeping — bump kill counter + check named-mob
  // triggers. Lazy-import so corpse.js stays unit-testable without
  // pulling the whole achievements catalog into the test harness.
  if (killer?.client?.account && !mob.client) {
    try {
      _achievementsModule ??= maybeLoadAchievements();
      if (_achievementsModule) {
        const acc = killer.client.account;
        const a = _achievementsModule;
        const unlocks = [
          ...a.progress(acc, 'kills', 1),
          ...a.trigger(acc, 'kill-kind', { kind: mob.kind }),
        ];
        for (const u of unlocks) {
          killer.client.sendSystemMessage?.(
            `★ Achievement unlocked: ${u.achievement.name}` +
            (u.grantedTitle ? ` (title: ${u.grantedTitle})` : '')
          );
        }
      }
    } catch { /* achievements are advisory */ }
  }

  // Notoriety bookkeeping — increment kill counter on the attacker if the
  // victim was Innocent, and re-broadcast the killer so other clients
  // re-colour their nameplate (red after 5 kills).
  // PHASE BY: faction kill counter — independent of murder count, so a
  // legitimate PvP faction skirmish doesn't pump the killer toward red.
  if (killer && recordFactionKill(killer, mob)) {
    killer.client?.sendSystemMessage?.(
      `Faction kill recorded (total: ${killer.factionKills}).`,
    );
  }
  // PHASE CX: Valor virtue accrual for slaying a non-player creature.
  // Reads `valor` from the monster config (or a HP-scaled fallback);
  // self-kills, suicides, and PK count are excluded by the
  // `recordKill` path below.
  if (killer && killer.client && !mob.client) {
    try {
      // Try the monster registry first; fall back to the mob itself so
      // tests that don't wire `_monstersGetter` still see HP-based valor
      // without needing a registry stub.
      const cfg = _monstersGetter?.(mob.kind) ?? mob;
      const valor = valorForKill(cfg);
      if (valor > 0) awardVirtue(killer, 'valor', valor);
    } catch { /* ignore — virtue is a side-effect, not critical */ }
  }
  // PHASE DF: pet training xp. The killer slot when a player's pet
  // lands the killing blow is the pet itself (combat code attributes
  // damage to the attacker mob, not its master). Train the pet, and
  // wire `pet._world` so the level-up notify can reach the master.
  if (killer && killer.controlMaster && !mob.client) {
    try {
      killer._world = world;
      const cfg = _monstersGetter?.(mob.kind) ?? mob;
      const xp = petXpForKill(cfg);
      if (xp > 0) awardPetXp(killer, xp);
    } catch { /* training is a nice-to-have */ }
  }
  if (killer && recordKill(killer, mob)) {
    if (killer.client) {
      killer.client.sendSystemMessage?.('You have committed a murder.');
    }
    const moving = mobileMoving({
      serial: killer.serial, body: killer.body,
      x: killer.x, y: killer.y, z: killer.z,
      direction: killer.direction, hue: killer.hue,
      flags: killer.flags, notoriety: killer.notoriety,
    });
    for (const other of world.mobiles.values()) {
      if (other.client) other.client.send(moving);
    }
  }
  const corpse = createItem(world, {
    itemId: CORPSE_ITEM_ID,
    x: mob.x, y: mob.y, z: mob.z,
    map: mob.map ?? 1,
    name: `a corpse of ${mob.name ?? 'a creature'}`,
    movable: false,
    hue: mob.hue ?? 0,
    gumpId: 0x0009, // ServUO corpse gump
    amount: mob.body ?? 0, // ClassicUO uses amount to render corpse body
  });
  trackCorpse(world, corpse);
  corpse.spawnedAt = Date.now();
  corpse.sourceKind = mob.kind ?? mob.creatureKind ?? null;
  corpse.sourceBody = mob.body ?? 0;
  corpse.sourceWasPlayer = !!mob.client || !!mob.isPlayer;
  corpse.carveYields = Array.isArray(mob.carveYields) ? mob.carveYields.map((row) => ({ ...row })) : null;
  try { dispatchXmlAttachment(mob, 'onDeath', { world, killer, corpse }); }
  catch (e) { console.error('[corpse] xml onDeath dispatch threw:', e?.message ?? e); }
  // Loot ownership lock — for the first 10 seconds the corpse is open
  // ONLY to the top damager (and their party). After that the lock
  // expires and anyone in range may loot. Mirrors ServUO
  // Corpse.cs `OnDoubleClick` private-loot phase.
  const top = getTopDamager(mob);
  if (top) {
    corpse.lootOwnerSerial = top.attackerSerial;
    corpse.lootLockUntil = corpse.spawnedAt + 10_000;
  }
  // PHASE EN: forensic clue — record killer's name on the corpse so
  // `[forensic` can reveal it. ServUO `Corpse.Killer` is the same
  // attribute. We store the name (string) rather than a serial because
  // mob serials don't survive disconnect/restart for player kills.
  if (killer) corpse.killerName = killer.name ?? 'an unknown attacker';
  // PHASE EU: charge insurance fee for any insured items the player is
  // wearing. The collect call runs BEFORE the corpse re-parent loop so
  // we know which items qualify; chargeInsurance defaults expired ones
  // (not enough gold) so they fall through to the normal corpse drop.
  if (mob.client) {
    try {
      const insured = collectInsuredItems(world, mob);
      if (insured.length > 0) {
        const result = chargeInsurance(mob, insured, world);
        if (result.charged > 0) {
          mob.client?.sendSystemMessage?.(
            `Insurance: ${result.charged} gp charged for ${insured.length - result.defaulted} item(s).`,
          );
        }
        if (result.defaulted > 0) {
          mob.client?.sendSystemMessage?.(
            `${result.defaulted} insured item(s) defaulted — they will drop normally.`,
          );
        }
      }
    } catch (e) { console.error('[corpse] insurance charge:', e); }
  }

  // Re-parent equipped items into the corpse container.
  // BUGFIX #32 (PHASE BP): fire onUnequip before clearing the layer so
  // lifecycle scripts can clean up worn-state side-effects (lit torches
  // would snuff, equip-driven buffs would tear down, etc.). Without this
  // the previous death path silently dropped the layer and a torch lit
  // on a doomed paladin's corpse stayed visually lit forever.
  // PHASE ES: items with `newbied: true` (starter equipment, quest
  // rewards) stay parented to the player and are NOT moved to the
  // corpse. ServUO `LootType.Blessed` parity. Insured items (PHASE EJ)
  // also bypass via the same path — they keep their layer too.
  // Bug-hunt B1 hot-spot — walk only items parented to `mob` via the
  // reverse `_childrenByParent` index when available. The 4 corpse.js
  // walks combined to ~440k iter per player death on a 110k-item shard.
  // Snapshot to array because we mutate `item.parent` inside the loop
  // (which would otherwise corrupt the live Set iterator).
  const ownIdx = world._childrenByParent?.get?.(mob.serial);
  const own = ownIdx
    ? Array.from(ownIdx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mob.serial);
  // Personal-bless filter: any item flagged `_personalBlessed` and bound
  // to this player's account stays on the player. Same skip path as
  // newbied / insured. Bug-hunt #3 NEW Personal Bless Deed.
  const blessAccount = (mob.accountName ?? mob.client?.account?.username ?? '').toLowerCase();
  // Player-corpse rule (ServUO `Corpse.cs Carve` + classic UO): the
  // BACKPACK (layer 21) stays on the player after death so they keep
  // a usable container on resurrect. The backpack's CONTENTS drop
  // into the corpse via the recursive walk below. Hair (11), Beard
  // (16), Mount (25), Bank (29), and FacialHair stay too. Everything
  // else on a worn layer drops to the corpse.
  // Was: every parent===mob.serial item (incl. backpack) was reparented
  // to corpse → resurrected player had NO backpack, couldn't re-equip
  // one (server rejects equipping a non-empty pack to layer 21).
  const KEEP_LAYERS = new Set([
    11,   // Hair
    16,   // FacialHair (beard)
    21,   // Backpack
    25,   // Mount
    29,   // Bank
  ]);
  const isPlayerCorpse = !!mob.client;
  for (const it of own) {
    if (it.newbied || it.blessed || it.spellbook || it.accountBound || it.insured
        || (blessAccount && it._personalBlessed === blessAccount)) {
      // Keep on the player; on resurrect they pop right back to layer.
      continue;
    }
    // Player corpses: skip slots that ServUO keeps on the body.
    if (isPlayerCorpse && KEEP_LAYERS.has(it.layer | 0)) continue;
    if ((it.layer ?? 0) > 0) {
      dispatchItemEvent(world, it, 'onUnequip', mob);
    }
    // Use setItemParent so the reverse index follows the move; falls
    // back to direct assignment when the helper isn't available.
    if (itemsMod?.setItemParent) itemsMod.setItemParent(world, it, corpse.serial);
    else it.parent = corpse.serial;
    it.layer = 0;
  }
  // Player corpse: drop the BACKPACK CONTENTS into the corpse. The pack
  // itself stays on the player (loop above skipped layer 21). Walk by
  // reverse-parent index so we don't iterate every item in the world.
  if (isPlayerCorpse) {
    const pack = own.find((it) => (it.layer | 0) === 21);
    if (pack) {
      const packIdx = world._childrenByParent?.get?.(pack.serial);
      const packKids = packIdx
        ? Array.from(packIdx, (s) => world.items.get(s)).filter(Boolean)
        : [...world.items.values()].filter((it) => it.parent === pack.serial);
      for (const kid of packKids) {
        if (kid.newbied || kid.blessed || kid.spellbook || kid.accountBound || kid.insured
            || (blessAccount && kid._personalBlessed === blessAccount)) continue;
        if (itemsMod?.setItemParent) itemsMod.setItemParent(world, kid, corpse.serial);
        else kid.parent = corpse.serial;
      }
    }
  }

  // Roll the mobile's loot table (if any) into the corpse.
  dropLoot(world, corpse, mob);

  // Bug fix — corpse was created server-side but never broadcast to
  // nearby clients, so the player saw nothing on the ground (and could
  // not double-click to loot). ClassicUO uses `amount` to render the
  // corpse body shape — pass `mob.body` (the still-alive body, used
  // for the lying-down sprite). ServUO sends this as `WorldItemSA`
  // (0xF3) followed by 0xAF DisplayDeathAction so the client's
  // CorpseManager registers the corpse with its facing and triggers
  // the Die1/Die2 fall animation.
  const wasRunning = !!mob.running;
  const deadBody = mob.body;     // capture BEFORE the ghost-body swap below
  try {
    const corpsePkt = worldItemSA({
      serial: corpse.serial,
      itemId: CORPSE_ITEM_ID,
      amount: deadBody ?? 0,
      x: corpse.x, y: corpse.y, z: corpse.z,
      direction: mob.direction ?? 0,
      hue: mob.hue ?? 0,
      flags: 0,
      dataType: 1,                     // 1 = corpse
      graphicInc: 0,
    });
    const deathPkt = deathAction({
      serial: mob.serial,
      corpseSerial: corpse.serial,
      running: wasRunning,
    });
    broadcastInRange(world, corpse, (client) => {
      client.send(corpsePkt);
      client.send(deathPkt);
    });
  } catch (e) {
    console.error('[corpse] worldItemSA/deathAction broadcast threw:', e);
  }

  // Broadcast: small death animation + sound + 0x6E "die" pose so the
  // mobile actually plays the canonical falling-down loop instead of
  // popping silently into a corpse. CUO action ids:
  //   humans (body >= 400): 21 = die_backwards (PAG_DIE_2)
  //   monsters (body < 200): 2 = die (HighAnimationGroup.Die)
  //   animals (200..399):    8 = die (LowAnimationGroup.Die1)
  // Death sound id derives from the mobile's body — defaults pick a
  // generic male / female / monster grunt when nothing custom set.
  const dieAction =
    (mob.body >= 400) ? 21 :
    (mob.body >= 200) ? 8 :
                        2;
  const deathSoundId = (mob.deathSound | 0)
    || ((mob.body >= 400)
          ? ((mob.body === 0x0191) ? 0x0150 : 0x0017)  // human f / m
          : 0x015B);                                      // generic creature
  broadcastInRange(world, mob, (client) => {
    client.send(graphicalEffect({
      kind: EffectKind.Stationary,
      from: mob.serial, to: mob.serial,
      itemId: 0x3728,
      fromX: mob.x, fromY: mob.y, fromZ: mob.z,
      toX: mob.x, toY: mob.y, toZ: mob.z,
      speed: 10, duration: 10,
    }));
    try {
      client.send(playerAnimation({
        serial: mob.serial, action: dieAction, frameCount: 5, repeatCount: 1,
      }));
    } catch { /* protocol shape may differ; tolerate */ }
    try {
      client.send(playSound({
        soundId: deathSoundId, x: mob.x, y: mob.y, z: mob.z,
      }));
    } catch { /* advisory */ }
  });

  if (mob.client) {
    // Player death: turn into a ghost and keep them in the world so they can
    // walk around and eventually be resurrected. Tag the mobile so spell/combat
    // tick code can treat them differently.
    // Detect gender from the live body id rather than a `mob.female` flag
    // that we never set anywhere. 0x0191 = human female; 0x0193 = already a
    // female ghost (defensive fallback if killMobile were ever re-entered).
    const isFemale = mob.body === 0x0191 || mob.body === 0x0193 || mob.sex === 1;
    const ghostBody = isFemale ? GHOST_BODY_FEMALE : GHOST_BODY_MALE;
    mob.ghost = true;
    mob.body = ghostBody;
    mob.hp = 0;
    mob.flags = (mob.flags ?? 0) & ~0x40; // clear warmode
    mob.client.combatant = 0;
    mob.client.send(deathStatus(0x00));
    // Bug fix — the dying client also needs a fresh mobileIncoming so
    // its own sprite re-mounts with the ghost body (CUO `World.OnMobileLogin`
    // re-creates the player Mobile when 0x78 with the ghost body comes
    // in). Sending only `mobileUpdate` leaves equipment slots cached
    // → renderer keeps drawing the alive sprite. Pre-emptive `removeEntity`
    // forces a clean rebuild on next 0x78.
    mob.client.send(removeEntity(mob.serial));
    mob.client.send(mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: 0, flags: mob.flags,
      notoriety: mob.notoriety ?? 1, equipment: [],
    }));
    mob.client.send(mobileUpdate({
      serial: mob.serial, body: mob.body, hue: 0,
      flags: mob.flags, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction,
    }));
    mob.client.send(healthUpdate({ serial: mob.serial, current: 0, max: mob.hpMax ?? 50 }));
    // Phase H.2 — sentinel opens the DeathGump (Resurrect at Healer /
    // Shrine / Remain a ghost). Routed through the standard system
    // message sniffer in game-scene.js.
    mob.client.sendSystemMessage?.('@@OPEN_DEATH_GUMP@@');
    // Show the ghost to nearby viewers.
    const incoming = mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: 0, flags: mob.flags,
      notoriety: mob.notoriety ?? 1, equipment: [],
    });
    broadcastInRange(world, mob, (client) => {
      if (client === mob.client) return;
      client.send(removeEntity(mob.serial));
      client.send(incoming);
    });
    mob.client.sendSystemMessage?.('You are dead.');
    emitMobileKilled(world, mob, killer, corpse);
    runKillHooks(world, mob, killer);
    return corpse;
  }

  emitMobileKilled(world, mob, killer, corpse);
  // NPC / monster: broadcast removal and drop from world.
  broadcastInRange(world, mob, (client) => {
    client.send(removeEntity(mob.serial));
  });
  // Use destroyMobile so the sector index entry is dropped too — raw
  // `mobiles.delete()` left stale serials in `mobileSerialsNear`
  // returns, slowly leaking memory across long-running shards (A4).
  world.destroyMobile?.(mob.serial);
  runKillHooks(world, mob, killer);
  return corpse;
}

const DEFAULT_CARVE_BY_KIND = Object.freeze([
  [/dragon|drake|serpent|snake|lizard|alligator|reptile/i, [{ itemId: 0x26B4, name: 'scales', amount: 8 }, { itemId: 0x09F1, name: 'raw ribs', amount: 2 }]],
  [/bird|eagle|chicken|ostard|harpy|crane/i, [{ itemId: 0x1BD1, name: 'feathers', amount: 12 }, { itemId: 0x09F1, name: 'raw bird', amount: 1 }]],
  [/sheep|goat|llama/i, [{ itemId: 0x0DF8, name: 'wool', amount: 3 }, { itemId: 0x09F1, name: 'raw ribs', amount: 2 }]],
  [/cow|bull|deer|hart|bear|wolf|horse|boar|pig|rat|rabbit|cat|dog/i, [{ itemId: 0x1078, name: 'hides', amount: 4 }, { itemId: 0x09F1, name: 'raw ribs', amount: 2 }]],
]);

/** Standard corpse carving transaction used by bladed-item scripts/commands. */
export function carveCorpse(world, corpseOrSerial, carver) {
  const corpse = typeof corpseOrSerial === 'number'
    ? world?.items?.get?.(corpseOrSerial >>> 0) : corpseOrSerial;
  if (!corpse || (corpse.itemId | 0) !== CORPSE_ITEM_ID) return { ok: false, reason: 'not-corpse' };
  if (!carver || (corpse.map | 0) !== (carver.map | 0)
      || Math.max(Math.abs((corpse.x | 0) - (carver.x | 0)), Math.abs((corpse.y | 0) - (carver.y | 0))) > 2) {
    return { ok: false, reason: 'out-of-range' };
  }
  if (corpse.carvedAt) return { ok: false, reason: 'already-carved' };
  if (corpse.lootLockUntil > Date.now() && corpse.lootOwnerSerial
      && (corpse.lootOwnerSerial >>> 0) !== (carver.serial >>> 0)) {
    return { ok: false, reason: 'loot-rights' };
  }
  corpse.carvedAt = Date.now();
  if (corpse.sourceWasPlayer) return { ok: true, items: [] };
  let yields = corpse.carveYields;
  if (!Array.isArray(yields)) {
    const kind = `${corpse.sourceKind ?? ''} ${corpse.name ?? ''}`;
    yields = DEFAULT_CARVE_BY_KIND.find(([pattern]) => pattern.test(kind))?.[1] ?? [];
  }
  const made = [];
  for (const row of yields.slice(0, 8)) {
    const amount = Math.max(1, Math.min(60000, row.amount | 0));
    const item = createItem(world, {
      itemId: row.itemId | 0, hue: row.hue ?? 0, amount,
      name: row.name, movable: true,
      x: 40 + made.length * 8, y: 40, z: 0, map: corpse.map,
      parent: corpse.serial, stackable: true,
    });
    made.push(item);
  }
  return { ok: true, items: made };
}

function emitMobileKilled(world, victim, killer, corpse) {
  try {
    world?.events?.emit?.('mobile:killed', { victim, killer, corpse });
  } catch { /* advisory */ }
}

function runKillHooks(world, victim, killer) {
  for (const hook of _killHooks) {
    try { hook(world, victim, killer); }
    catch (e) { console.error('[corpse] killHook threw:', e); }
  }
}

/**
 * Resurrect a previously killed player-mobile. Restores body, clears ghost
 * flag, fills HP, and re-broadcasts the mobile so viewers see the living form.
 *
 * @param {World} world
 * @param {import('./world/world.js').Mobile} mob
 * @param {import('./world/world.js').Mobile} [resurrector]  e.g. shrine NPC
 *        or a friendly player — when set and not the same as `mob`, the
 *        resurrector earns Compassion virtue (PHASE DG).
 */
export function resurrectMobile(world, mob, resurrector = null) {
  if (!mob.ghost) return;
  mob.ghost = false;
  // Drop the kill-credit ledger from the previous life so a resurrected
  // player doesn't carry forward damage from the fight that killed them.
  // Without this, a re-engaged attacker would still show as the "top
  // damager" on subsequent corpses minutes later.
  clearDamageEntries(mob);
  // ServUO StatLossAfterResurrect — if the player is still flagged
  // murderer at res time (5+ short-term kills), apply -1/5 to every
  // stat and -1/5 to every skill for 8 minutes. Stamps `_statLossUntil`
  // and the original values; the sweep in main.js restores them when
  // the timer elapses. Penalty is multiplicative per ServUO formula:
  // newValue = floor(value * 0.8).
  // Audit #35 P3 #13 — ServUO `ResurrectGump.cs:259-280` pre-AOS path:
  // permanent multiplicative reduction of raw stats + skill bases. There
  // is no "restore originals later" — gains earned during the penalty
  // window were silently reverted on restore, an obvious frustration.
  // AOS replaced this with the Justice virtue and report-murderer
  // mechanic. The 0.8× we used was harsher than canonical 0.85-0.95×.
  // Apply once, in place; skip skills whose post-loss value would be
  // below 35 (ServUO `ResurrectGump.cs:277`). Sweep timer (sweepStatLoss)
  // no longer needs to fire — it remains in place but is a no-op when
  // `_statLossUntil` is unset.
  if ((mob.kills | 0) >= 5 && !mob._statLossApplied) {
    const lossPct = Math.max(0.85,
      Math.min(0.95, 1 - (4 + (mob.kills | 0) / 5) / 100));
    mob.str    = Math.max(10, Math.floor((mob.str    | 0) * lossPct));
    mob.dex    = Math.max(10, Math.floor((mob.dex    | 0) * lossPct));
    mob.int    = Math.max(10, Math.floor((mob.int    | 0) * lossPct));
    mob.hpMax  = Math.max(10, Math.floor((mob.hpMax  | 0) * lossPct));
    mob.manaMax= Math.max(10, Math.floor((mob.manaMax| 0) * lossPct));
    mob.stamMax= Math.max(10, Math.floor((mob.stamMax| 0) * lossPct));
    if (mob.skills) {
      for (const k of Object.keys(mob.skills)) {
        const v = normalizeSkillValue(mob.skills[k]);
        if (v <= 0) continue;
        // ServUO 277: skip skills where loss would push base ≤ 35 —
        // protects newbie skills from disappearing entirely.
        if (Math.floor(v * lossPct) <= 35) continue;
        mob.skills[k] = Math.floor(v * lossPct);
      }
    }
    mob._statLossApplied = true;
    // Legacy flag kept for any test fixture still asserting on it;
    // sweepStatLoss reads `_statLossUntil` so leaving it null is safe.
    mob._statLossUntil = 0;
    if (mob.client?.sendSystemMessage) {
      mob.client.sendSystemMessage(
        'You feel weakened from your wickedness — your stats and skills are permanently reduced.');
    }
  }
  // Audit #34 P2 #1 — ServUO `ResurrectGump.cs:252-257` docks Fame/10
  // on every resurrection, regardless of source (shrine, healer, self).
  // Was a complete miss — title pills never decayed after death.
  if ((mob.fame | 0) > 0) {
    const loss = Math.floor(mob.fame / 10);
    mob.fame = Math.max(0, (mob.fame | 0) - loss);
  }
  // Server parity #14 #2 — Resurrection sickness. ServUO
  // `PlayerMobile.OnAfterResurrect → ApplyResurrectionSickness`: 120 s
  // gate on full-power cast / swing / heal regardless of PK status.
  // Without this, mage shrine-cycle was free.
  mob._resSicknessUntil = Date.now() + 120_000;
  mob.client?.sendSystemMessage?.(
    'You are weakened by your recent death. Your skills and stats are reduced for 2 minutes.',
  );
  // Remember the player's sex so resurrection restores the right body even if
  // the mobile ever loses its `sex` attribute between save/load cycles.
  const isFemale = mob.sex === 1
    || mob.body === 0x0193   // female ghost
    || mob.body === 0x0191;  // already female alive (shouldn't happen on a ghost)
  mob.body = isFemale ? 0x0191 : 0x0190;
  mob.hp = Math.max(1, Math.floor((mob.hpMax ?? 50) / 2));
  if (mob.client) {
    mob.client.send(deathStatus(0x02));
    mob.client.send(mobileUpdate({
      serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
      flags: mob.flags ?? 0, x: mob.x, y: mob.y, z: mob.z, direction: mob.direction,
    }));
    mob.client.send(healthUpdate({
      serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
    }));
    mob.client.sendSystemMessage?.('You have been resurrected.');
  }
  // BUGFIX #66 (PHASE CX): the previous mobileIncoming sent an empty
  // equipment array — observers saw the resurrected player as a
  // naked mannequin until they walked away and back. Scan items
  // parented + worn on the mob via the reverse index so the
  // 110k-item walk drops to ~10 worn-slot iterations.
  const equipment = [];
  const equipIdx = world._childrenByParent?.get?.(mob.serial);
  const equipIter = equipIdx
    ? Array.from(equipIdx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mob.serial);
  for (const it of equipIter) {
    if (!(it.layer > 0)) continue;
    equipment.push({
      serial: it.serial, itemId: it.itemId,
      layer: it.layer, hue: it.hue ?? 0,
    });
  }
  const incoming = mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue ?? 0, flags: mob.flags ?? 0,
    notoriety: mob.notoriety ?? 1, equipment,
  });
  // BUGFIX #75 (PHASE DG): observer health bars stayed on ghost values
  // after res. mobileIncoming carries body/hue but not hp — without an
  // explicit healthUpdate broadcast, party members' bars showed 0/50
  // until the next damage tick. Same bug class as #55, #64, #69.
  const resurrected = healthUpdate({
    serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
  });
  broadcastInRange(world, mob, (client) => {
    if (client === mob.client) return;
    client.send(removeEntity(mob.serial));
    client.send(incoming);
    client.send(resurrected);
  });
  // PHASE DG: a different mobile resurrected this one — that's an act of
  // Compassion in the canonical UO virtue list. ServUO awards 200 per
  // assist; we follow the same heuristic.
  if (resurrector && resurrector !== mob && resurrector.client) {
    try { awardVirtue(resurrector, 'compassion', 200); }
    catch { /* virtue is a side effect, not critical */ }
  }
}

/**
 * Sweep players whose stat-loss timer has expired and restore their
 * original stats/skills. Idempotent — players without an active timer
 * are skipped. Cheap O(online players); run from main.js's 1-min loop.
 */
export function sweepStatLoss(world, now = Date.now()) {
  let restored = 0;
  for (const mob of world.mobiles.values()) {
    if (!mob._statLossUntil || mob._statLossUntil > now) continue;
    const orig = mob._statLossOriginals;
    if (orig) {
      mob.str    = orig.str;
      mob.dex    = orig.dex;
      mob.int    = orig.int;
      mob.hpMax  = orig.hpMax;
      mob.manaMax= orig.manaMax;
      mob.stamMax= orig.stamMax;
      if (mob.skills && orig.skills) {
        for (const k of Object.keys(orig.skills)) mob.skills[k] = orig.skills[k];
      }
    }
    mob._statLossUntil = 0;
    mob._statLossOriginals = null;
    if (mob.client?.sendSystemMessage) {
      mob.client.sendSystemMessage('Your strength returns — the stat-loss penalty has ended.');
    }
    restored++;
  }
  return restored;
}

/** Delete a corpse and everything inside it. */
export function decayCorpse(world, corpseSerial) {
  // BUGFIX #65 (PHASE CW): capture corpse position BEFORE destroy so
  // the removeEntity broadcast can apply a visibility gate. The
  // previous loop fired removeEntity to EVERY connected client on
  // every corpse decay (every 30 s sweeper) — N×M packets per tick
  // for free. Filter by map + 18 tile radius like every other UO
  // proximity broadcast.
  const corpseItem = world.items?.get?.(corpseSerial);
  const center = corpseItem ? {
    x: corpseItem.x, y: corpseItem.y, map: corpseItem.map,
  } : null;
  for (const child of [...containerChildren(world, corpseSerial)]) {
    destroyItem(world, child.serial);
  }
  untrackCorpse(world, corpseSerial);
  destroyItem(world, corpseSerial);
  for (const m of world.mobiles.values()) {
    if (!m.client) continue;
    if (center) {
      if (m.map !== center.map) continue;
      if (Math.abs(m.x - center.x) > 18 || Math.abs(m.y - center.y) > 18) continue;
    }
    m.client.send(removeEntity(corpseSerial));
  }
}

// ServUO `Corpse.cs:421 m_DefaultDecayTime = TimeSpan.FromMinutes(7)`.
// Bumped from 5 → 7 minutes for canonical parity; gives the killer +
// nearby looters a CUO-equivalent window before the corpse vanishes.
const CORPSE_DECAY_MS = 7 * 60 * 1000;

/**
 * Scan the dedicated corpse-serial index for entries older than the decay
 * window and remove them. Call at a slow cadence (for example every 30s).
 *
 * @param {World} world
 */
export function sweepDecayedCorpses(world) {
  const now = Date.now();
  const stale = [];
  const corpses = ensureCorpseIndex(world);
  for (const serial of [...corpses]) {
    const it = world.items.get(serial);
    if (!it || (it.itemId | 0) !== CORPSE_ITEM_ID) {
      corpses.delete(serial);
      continue;
    }
    if (!it.spawnedAt) { it.spawnedAt = now; continue; }
    if (now - it.spawnedAt >= CORPSE_DECAY_MS) stale.push(it.serial);
  }
  for (const serial of stale) decayCorpse(world, serial);
  return stale.length;
}

function broadcastInRange(world, origin, fn) {
  for (const m of world.mobiles.values()) {
    if (!m.client) continue;
    const dx = Math.abs(m.x - origin.x);
    const dy = Math.abs(m.y - origin.y);
    if (dx <= 18 && dy <= 18) fn(m.client);
  }
}

/**
 * Roll the mobile's `lootTable` (an array of `{itemId, hue?, amount?|[min,max],
 * chance?, name?}` entries) and drop the rolls into the corpse. Also drops
 * the mobile's `gold` as a gold pile.
 *
 * @param {World} world
 * @param {import('./world/items.js').Item} corpse
 * @param {import('./world/world.js').Mobile} mob
 */
function dropLoot(world, corpse, mob) {
  // BUGFIX #72 (PHASE DD): paragon kills are supposed to drop 1.5×
  // loot — that's the whole point of the buff. The system was wired
  // (paragons.js exports `paragonLootMultiplier`) but corpse.dropLoot
  // never read it, so paragon corpses produced vanilla piles. Paragon
  // mob = same gold pile and same drop counts as a regular spawn.
  const paragonMult = mob?.paragon ? 1.5 : 1.0;
  const despoilMult = (Number(mob?.ethicDespoilUntil) || 0) > Date.now() ? 2 : 1;
  const lootMult = paragonMult * despoilMult;
  const gold = Math.round((mob.gold | 0) * lootMult);
  if (gold > 0) {
    createItem(world, {
      itemId: 0x0EED, // gold coin pile
      amount: gold,
      x: corpse.x, y: corpse.y, z: corpse.z,
      map: corpse.map,
      parent: corpse.serial,
      name: 'gold',
      movable: true,
    });
  }
  if (mob?.paragon) {
    const fame = Math.max(0, mob.fame | 0);
    const level = fame >= 32000 ? 6
      : fame >= 24000 ? 5
      : fame >= 16000 ? 4
      : fame >= 8000 ? 3
      : fame >= 4000 ? 2
      : 1;
    const chance = Math.min(0.30, 0.08 + level * 0.025);
    if (Math.random() < chance) {
      createItem(world, {
        itemId: [0x09AB, 0x0E40, 0x0E41, 0x0E7C][Math.floor(Math.random() * 4)],
        hue: [0x000, 0x455, 0x47E, 0x89F, 0x8A5, 0x8AB, 0x966, 0x96D, 0x972, 0x973, 0x979][Math.floor(Math.random() * 11)],
        x: 40, y: 40, z: 0, map: corpse.map,
        parent: corpse.serial,
        name: `${mob.name ?? 'Paragon'}'s Chest`,
        movable: true,
        kind: 'container',
        container: true,
        gumpId: 0x0048,
        script: 'treasure-chest',
        servuoClass: 'ParagonChest',
        paragonChest: true,
        locked: true,
        treasureLevel: level,
        treasureLooted: false,
        trapped: { level, damage: 25 },
        requiredSkill: [0, 36, 76, 84, 92, 100, 100][level],
      });
    }
  }
  const table = mob.lootTable;
  // Wave 9: monsters can list multiple loot tables — most commonly a
  // base table plus a low-chance rare table. ServUO `LootPack` chains
  // work the same way (BasePack + RarePack on champions/bosses).
  // Backwards-compat: `mob.lootTable = "name"` still works.
  const tableNames = Array.isArray(table) ? table : (typeof table === 'string' ? [table] : null);
  if (tableNames && lootRegistry) {
    const dropped = [];
    // ServUO LootGeneration difficulty scaling: derive 0..1 difficulty
    // from fame (60k=boss) and hpMax (1000+=boss). Mobs at low fame
    // and HP get vanilla rolls; champions/peerless get the scaled
    // gold and magic-item budget bump.
    const fame = Math.max(0, mob.fame | 0);
    const hpMax = Math.max(1, mob.hpMax | 0);
    const difficulty = Math.max(0, Math.min(1,
      Math.max(fame / 60000, hpMax / 2000)));
    const creatureKind = mob.kind || mob.creatureKind || null;
    const scaledOpts = {
      difficulty,
      creatureKind,
      bonusMagic: difficulty > 0.7 ? Math.floor((difficulty - 0.5) * 4) : 0,
      bonusArtifactChance: difficulty > 0.9 ? (difficulty - 0.9) * 2 : 0,
    };
    const useScaled = difficulty > 0.25 && typeof lootRegistry.rollScaled === 'function';
    for (const name of tableNames) {
      try {
        const rolls = useScaled
          ? lootRegistry.rollScaled(world, corpse, name, scaledOpts)
          : lootRegistry.roll(world, corpse, name);
        dropped.push(...rolls);
      }
      catch (e) { console.warn(`[corpse] loot roll '${name}' failed: ${e.message}`); }
    }
    // Scale stack-amounts after roll. We can't pass a multiplier into
    // the registry without changing its signature + tests, so apply it
    // here. Stackable items (gold piles, reagents, arrows) honor amount;
    // single-instance items don't grow but DO upgrade quality if the
    // registry rolls multiple of them.
    if (lootMult !== 1.0) {
      for (const it of dropped) {
        if ((it.amount ?? 1) > 1) it.amount = Math.round(it.amount * lootMult);
      }
    }
    return;
  }
  if (!Array.isArray(table)) return;
  for (const entry of table) {
    if (!entry || typeof entry.itemId !== 'number') continue;
    if (typeof entry.chance === 'number' && Math.random() >= entry.chance) continue;
    let amount = 1;
    if (Array.isArray(entry.amount)) {
      const [lo, hi] = entry.amount;
      amount = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
    } else if (typeof entry.amount === 'number') {
      amount = entry.amount;
    }
    amount = Math.max(1, Math.round(amount * lootMult));
    createItem(world, {
      itemId: entry.itemId,
      hue: entry.hue ?? 0,
      amount,
      x: corpse.x, y: corpse.y, z: corpse.z,
      map: corpse.map,
      parent: corpse.serial,
      name: entry.name,
      movable: true,
    });
  }
}

// =====================================================================
//  Achievements lazy loader — keeps unit tests independent of the
//  catalog import side effects. Loaded once on first use.
// =====================================================================
let _achievementsModule = undefined;
function maybeLoadAchievements() {
  try {
    return globalThis.__uoAchievements ?? null;
  } catch { return null; }
}

/**
 * Late-bind hook called by main.js after the module graph is fully
 * loaded. Avoids a top-level circular import (corpse → achievements →
 * world → corpse).
 */
export function setAchievementsModule(mod) {
  _achievementsModule = mod ?? null;
}
