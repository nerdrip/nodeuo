// Boss AI — extends the basic aggressive behavior with periodic special
// abilities pulled from the monster's `specialAbilities` array (extracted
// from ServUO `Mobiles/Bosses/*.cs`).
//
// Special abilities cycle on a per-boss timer (every 8-15 s, jittered)
// and dispatch through a small dispatch table that turns each ServUO
// SpecialAbility name into damage / FX / sound effects via `api.combat`.
//
// We don't try to 1:1 port every boss script (those add bespoke rituals,
// spawn minions, etc.). Instead the dispatch table covers the common
// effects and individual bosses just list which ones they use.

import { spawnNPC } from '../vendors/_spawn.js';
import { createMobile } from '../../_mobiles.js';
import { nearbyMobiles, sendToClientsNear } from '../../_spatial.js';

const ABILITY_EFFECTS = {
  // Targeted abilities (deal damage to current target)
  DragonBreath: {
    damageRange: [25, 50], type: 'fire',
    fx: { graphicId: 14000, soundId: 0x227, fxSpeed: 8 },
    cooldownMs: 12000,
    range: 8,
  },
  Vomit: {
    damageRange: [15, 30], type: 'physical',
    fx: { graphicId: 14154, soundId: 0x1FB, fxSpeed: 5 },
    cooldownMs: 9000, range: 4,
  },
  GraspingClaw: {
    damageRange: [20, 35], type: 'physical', stamDrain: 30,
    fx: { graphicId: 0x37B9, soundId: 0x208, fxSpeed: 4 },
    cooldownMs: 10000, range: 1,
  },
  ColossalBlow: {
    damageRange: [40, 70], type: 'physical', knockback: 4,
    fx: { graphicId: 0x36BD, soundId: 0x10E, fxSpeed: 3 },
    cooldownMs: 15000, range: 1,
  },
  ConductiveBlast: {
    damageRange: [30, 50], type: 'energy',
    fx: { graphicId: 14264, soundId: 0x29C, fxSpeed: 6 },
    cooldownMs: 11000, range: 6,
  },
  FlurryForce: {
    damageRange: [20, 35], type: 'cold',
    fx: { graphicId: 0x375A, soundId: 0x10F, fxSpeed: 6 },
    cooldownMs: 8000, range: 5,
  },
  RuneCorruption: {
    damageRange: [20, 35], type: 'poison',
    fx: { graphicId: 0x37B9, soundId: 0x205, fxSpeed: 5 },
    cooldownMs: 11000, range: 4,
  },
  RagingGrasp: {
    damageRange: [30, 50], type: 'physical',
    fx: { graphicId: 0x37BB, soundId: 0x1FA, fxSpeed: 3 },
    cooldownMs: 13000, range: 2,
  },
  RepellingCharge: {
    damageRange: [25, 40], type: 'physical', knockback: 6,
    fx: { graphicId: 0x36BD, soundId: 0x213, fxSpeed: 3 },
    cooldownMs: 14000, range: 8,
  },
  SearingWounds: {
    damageRange: [20, 35], type: 'fire', poison: true,
    fx: { graphicId: 0x36CB, soundId: 0x208, fxSpeed: 5 },
    cooldownMs: 10000, range: 4,
  },
  StealLife: {
    damageRange: [25, 45], type: 'cold', leech: true,
    fx: { graphicId: 14154, soundId: 0x1FE, fxSpeed: 8 },
    cooldownMs: 12000, range: 6,
  },
  SuckerPunch: {
    damageRange: [35, 55], type: 'physical', stunMs: 2000,
    fx: { graphicId: 0x37BB, soundId: 0x1FE, fxSpeed: 3 },
    cooldownMs: 11000, range: 1,
  },
  SwarmingSpiders: {
    damageRange: [10, 20], type: 'poison', poisonDuration: 8000,
    fx: { graphicId: 0x028C, soundId: 0x4F1, fxSpeed: 6 },
    cooldownMs: 14000, range: 5,
  },
  WallOfFire: {
    damageRange: [25, 40], type: 'fire',
    fx: { graphicId: 14000, soundId: 0x227, fxSpeed: 5 },
    cooldownMs: 13000, range: 6, aoe: 3,
  },
  VenomousBite: {
    damageRange: [15, 30], type: 'poison', poisonDuration: 12000,
    fx: { graphicId: 0x37B9, soundId: 0x205, fxSpeed: 6 },
    cooldownMs: 10000, range: 1,
  },
  Polymorph: {
    selfBuff: 'transform',
    fx: { graphicId: 0x376A, soundId: 0x214, fxSpeed: 5 },
    cooldownMs: 25000, range: 0,
  },
  Heal: {
    selfBuff: 'heal', healPercent: 0.25,
    fx: { graphicId: 0x376A, soundId: 0x202, fxSpeed: 5 },
    cooldownMs: 20000, range: 0,
  },
  NauseatingMist: {
    damageRange: [15, 25], type: 'poison', stamDrain: 50,
    fx: { graphicId: 0x37BB, soundId: 0x1FB, fxSpeed: 4 },
    cooldownMs: 12000, range: 5, aoe: 4,
  },
  BarracoonPolymorph: {
    special: 'barracoon-polymorph',
    fx: { graphicId: 0x376A, soundId: 0x01FE, fxSpeed: 5 },
    cooldownMs: 18000, range: 10,
  },
  BarracoonSpawnRatmen: {
    special: 'summon',
    summonKinds: ['ratman', 'ratman-archer', 'ratman-mage'],
    summonCount: [3, 6],
    summonLimit: 16,
    fx: { graphicId: 0x3728, soundId: 0x003D, fxSpeed: 6 },
    cooldownMs: 25000, range: 10,
  },
  MedusaGaze: {
    special: 'medusa-gaze',
    fx: { graphicId: 0x376A, soundId: 0x01E9, fxSpeed: 4, hue: 0x047F },
    cooldownMs: 16000, range: 10,
  },
  MedusaClone: {
    special: 'clone',
    cloneKind: 'medusa-clone',
    fx: { graphicId: 0x3728, soundId: 0x01FE, fxSpeed: 6, hue: 0x0455 },
    cooldownMs: 24000, range: 10,
  },
  PrimevalTeleport: {
    special: 'teleport-target',
    fx: { graphicId: 0x3728, soundId: 0x01FE, fxSpeed: 10 },
    cooldownMs: 5000, range: 16,
  },
  PrimevalBlastRadius: {
    damageRange: [100, 200], type: 'energy',
    fx: { graphicId: 0x3709, soundId: 0x64C, fxSpeed: 10, hue: 90 },
    cooldownMs: 30000, range: 16, aoe: 16,
  },
  PrimevalLightning: {
    damageRange: [100, 200], type: 'energy',
    fx: { graphicId: 0x3818, soundId: 0x51D, fxSpeed: 10 },
    cooldownMs: 28000, range: 16, aoe: 6,
  },
  StygianFireball: {
    damageRange: [45, 75], type: 'fire',
    fx: { graphicId: 0x36D4, soundId: 0x15E, fxSpeed: 8, explodes: 1 },
    cooldownMs: 12000, range: 12, aoe: 2,
  },
  StygianCrimsonMeteor: {
    damageRange: [70, 120], type: 'fire',
    fx: { graphicId: 0x36BD, soundId: 0x208, fxSpeed: 6, hue: 0x0025, explodes: 1 },
    cooldownMs: 22000, range: 14, aoe: 4,
  },
};

/** Broadcast a boss FX (graphic + sound) to every nearby viewer of `mob`.
 *  ServUO uses `Effects.SendMovingEffect` / `Effects.PlaySound`; ours
 *  mirrors via `protocol.huedEffect` for the moving sprite and
 *  `combat.playSoundNear` for the audio. Previous code called
 *  `api.combat.animate(mob, target, fx.fx)` with the wrong signature
 *  (animate expects `(world, mob, actionId, opts)` — `fx.fx` is a
 *  descriptor, not an action) so every boss special was a silent no-op
 *  swallowed by the try/catch. */
function broadcastFx(api, mob, target, fx) {
  if (!fx) return;
  const world = api.world;
  const proto = api.protocol;
  if (proto?.huedEffect && fx.graphicId) {
    try {
      const dest = target ?? mob;
      const pkt = proto.huedEffect({
        kind: target && target !== mob ? (proto.EffectKind?.Moving ?? 1) : (proto.EffectKind?.Lightning ?? 1),
        from: mob.serial, to: dest.serial,
        itemId: fx.graphicId,
        fromX: mob.x, fromY: mob.y, fromZ: mob.z,
        toX: dest.x, toY: dest.y, toZ: dest.z,
        speed: fx.fxSpeed ?? 5, duration: 0,
        fixedDirection: 1, explodes: fx.explodes ?? 0,
        hue: fx.hue ?? 0, renderMode: 0,
      });
      sendToClientsNear(api, mob, pkt);
    } catch { /* fx is advisory */ }
  }
  if (fx.soundId != null && api.combat?.playSoundNear) {
    try { api.combat.playSoundNear(world, mob, fx.soundId); }
    catch { /* sfx is advisory */ }
  }
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function spawnBossMinion(api, mob, kind, target = null, extra = {}) {
  const cfg = api.monsters?.get?.(kind);
  const dx = randomInt(-2, 2);
  const dy = randomInt(-2, 2);
  const pos = {
    x: (mob.x | 0) + dx,
    y: (mob.y | 0) + dy,
    z: mob.z | 0,
    map: mob.map ?? 1,
  };
  let minion = null;
  if (api.ctx?.spawnFactory && cfg) {
    try { minion = api.ctx.spawnFactory(api.world, kind, pos); }
    catch { /* fall through */ }
  }
  if (!minion) {
    minion = createMobile(api, {
      name: cfg?.name ?? kind,
      body: cfg?.body ?? 0x0190,
      hue: cfg?.hue ?? 0,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      map: pos.map,
      notoriety: cfg?.notoriety ?? 5,
      hp: cfg?.hp ?? 80,
      hpMax: cfg?.hpMax ?? cfg?.hp ?? 80,
      str: cfg?.str ?? 80,
      dex: cfg?.dex ?? 80,
      int: cfg?.int ?? 40,
      kind,
      ...extra,
    });
  }
  if (minion) {
    minion.team = mob.team;
    minion.controlTarget = target?.serial ?? null;
    try { api.ai?.attach?.(minion, cfg?.boss ? 'boss' : (cfg?.behavior ?? 'aggressive')); }
    catch { /* advisory */ }
  }
  return minion;
}

function countNearbyKinds(api, mob, kinds, range) {
  let n = 0;
  for (const other of nearbyMobiles(api, mob, mob, range)) {
    if (kinds.includes(other.kind)) n++;
  }
  return n;
}

function applyBarracoonPolymorph(api, mob, target) {
  if (!target) return;
  const now = api.now?.() ?? Date.now();
  if (!target._servuoOriginalBody) {
    target._servuoOriginalBody = target.body;
    target._servuoOriginalHue = target.hue ?? 0;
  }
  target.body = 42;
  target.hue = 0;
  target._servuoPolymorphUntil = now + 3 * 60 * 1000;
  target._servuoPolymorphBy = mob.serial;
  target.client?.sendSystemMessage?.('Barracoon changes your shape into a ratman.');
}

function applyMedusaGaze(_api, _mob, target) {
  if (!target) return;
  const now = Date.now();
  target._medusaStoneUntil = now + 10_000;
  target._paralyzedUntil = Math.max(target._paralyzedUntil ?? 0, target._medusaStoneUntil);
  target.client?.sendSystemMessage?.("Medusa's gaze turns you to stone.");
}

function teleportNearBoss(api, mob, target) {
  if (!target) return;
  const old = { x: target.x, y: target.y, z: target.z, map: target.map };
  target.x = (mob.x | 0) + randomInt(-1, 1);
  target.y = (mob.y | 0) + randomInt(-1, 1);
  target.z = mob.z | 0;
  target.map = mob.map ?? target.map;
  target.direction = ((target.direction ?? 0) + 4) & 7;
  target.client?.sendSystemMessage?.('A dark force drags you toward the Primeval Lich.');
  if (api.protocol?.huedEffect) {
    const fx = { graphicId: 0x3728, soundId: 0x01FE, fxSpeed: 10 };
    broadcastFx(api, { ...mob, x: old.x, y: old.y, z: old.z, map: old.map }, target, fx);
  }
}

function fireSpecial(api, mob, target, fx) {
  switch (fx.special) {
    case 'barracoon-polymorph':
      applyBarracoonPolymorph(api, mob, target);
      return true;
    case 'medusa-gaze':
      applyMedusaGaze(api, mob, target);
      return true;
    case 'teleport-target':
      teleportNearBoss(api, mob, target);
      return true;
    case 'clone': {
      if (!target) return true;
      spawnBossMinion(api, mob, fx.cloneKind ?? 'medusa-clone', target, {
        name: `${target.name ?? 'a victim'}'s reflection`,
        body: target.body,
        hue: target.hue ?? 0,
        hp: Math.max(50, Math.floor((target.hpMax ?? target.hp ?? 100) * 0.5)),
        hpMax: Math.max(50, Math.floor((target.hpMax ?? target.hp ?? 100) * 0.5)),
        servuoClass: 'MedusaClone',
        servuoClasses: ['MedusaClone', 'AddCloneCommands'],
      });
      return true;
    }
    case 'summon': {
      const kinds = fx.summonKinds ?? [];
      if (kinds.length === 0) return true;
      if (countNearbyKinds(api, mob, kinds, 10) >= (fx.summonLimit ?? 16)) return true;
      const [min, max] = fx.summonCount ?? [1, 1];
      const n = randomInt(min, max);
      for (let i = 0; i < n; i++) {
        spawnBossMinion(api, mob, kinds[randomInt(0, kinds.length - 1)], target);
      }
      return true;
    }
    default:
      return false;
  }
}

/** Dispatch a single ability hit. Used by the per-boss tick loop below. */
function fireAbility(api, mob, target, abilityName) {
  const fx = ABILITY_EFFECTS[abilityName];
  if (!fx) return;
  if (!api.combat) return;
  // FX broadcast — even for self-buffs, players see something happen.
  broadcastFx(api, mob, target, fx.fx);
  if (fx.special && fireSpecial(api, mob, target, fx)) return;
  // Self-buff branch (heal / polymorph).
  if (fx.selfBuff === 'heal') {
    const heal = Math.floor((mob.hpMax ?? mob.hp ?? 100) * (fx.healPercent ?? 0.2));
    mob.hp = Math.min(mob.hpMax ?? heal * 5, (mob.hp ?? 0) + heal);
    if (api.protocol?.broadcastMobileHits) api.protocol.broadcastMobileHits(mob);
    return;
  }
  if (fx.selfBuff === 'transform') {
    // Mark as transformed so the next render swaps body. The actual
    // body swap is best-effort; not every server scaffolds it.
    mob._transformedAt = api.now?.();
    return;
  }
  if (!target) return;
  // AoE branch — damage every player within `aoe` tiles of target.
  const baseDmg = fx.damageRange
    ? fx.damageRange[0] + Math.floor(Math.random() * (fx.damageRange[1] - fx.damageRange[0] + 1))
    : 0;
  if (fx.aoe) {
    const victims = nearbyMobiles(api, target, null, fx.aoe);
    for (const other of victims) {
      if (!other.client) continue;
      if (other.map !== target.map) continue;
      const d = Math.max(Math.abs(other.x - target.x), Math.abs(other.y - target.y));
      if (d > fx.aoe) continue;
      // damage() signature: (world, target, amount, attacker).
      // Extra opts (type/stamDrain/etc.) aren't accepted at this hook
      // — they'd need bespoke status-effect application. The base
      // damage is what visibly lands; flavour riders are best-effort.
      try { api.combat.damage(api.world, other, baseDmg, mob); }
      catch { /* best-effort */ }
    }
    return;
  }
  // Single target.
  try { api.combat.damage(api.world, target, baseDmg, mob); }
  catch { /* best-effort */ }
  // Stam drain rider — many boss abilities (NauseatingMist, etc.)
  // strip stamina alongside damage. Cheap one-touch since combat.damage
  // doesn't expose a stam slot.
  if (fx.stamDrain && Number.isFinite(target.stam)) {
    target.stam = Math.max(0, (target.stam | 0) - (fx.stamDrain | 0));
  }
}

/** Per-tick AI scheduler — picks the next ability whose cooldown is up. */
function tickBoss(api, mob, target) {
  const now = api.now?.() ?? Date.now();
  const abilities = mob._cfg?.specialAbilities;
  if (!abilities?.length) return;
  if (!mob._abilityCooldowns) mob._abilityCooldowns = {};
  const cd = mob._abilityCooldowns;
  // Find a ready ability, prefer the one with the longest unused interval.
  let best = null;
  for (const name of abilities) {
    if ((cd[name] ?? 0) <= now) {
      if (!best || (now - (cd[name] ?? 0)) > (now - (cd[best] ?? 0))) best = name;
    }
  }
  if (!best) return;
  const fx = ABILITY_EFFECTS[best];
  // Reach gate — abilities with range 0 are self-buffs (always available);
  // > 0 require target within that distance.
  if (target && fx?.range > 0) {
    const d = Math.max(Math.abs(target.x - mob.x), Math.abs(target.y - mob.y));
    if (d > fx.range) return;
  }
  fireAbility(api, mob, target, best);
  cd[best] = now + (fx?.cooldownMs ?? 10000);
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat || !api.spawner || !api.monsters) {
    api.log?.('boss-ai: dependencies missing; skipping');
    return () => {};
  }

  // Register the boss tick on every spawned boss-flagged monster.
  // ai.registerBehavior expects a `{ name, tick(ctx, mob, state) }`
  // shape — the previous `('boss', { onTick })` signature passed the
  // string 'boss' as the behavior bag and threw "behavior must have
  // name + tick()" at every script load. Callers (`api.ai.attach(mob,
  // 'boss')` below) lookup by name, so the binding never landed and
  // every boss stood inert. Same fix as named.js.
  api.ai.registerBehavior?.({
    name: 'boss',
    tick(_ctx, mob /* , state */) {
      const cfg = api.monsters.get(mob.kind) ?? {};
      mob._cfg = cfg;
      let target = null, bestD = (cfg.aggroRange ?? 18) + 1;
      const candidates = nearbyMobiles(api, mob, mob, cfg.aggroRange ?? 18);
      for (const other of candidates) {
        if (!other.client || other.map !== mob.map) continue;
        if ((other.hp ?? 0) <= 0 || other.ghost) continue;
        const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
        if (d < bestD) { target = other; bestD = d; }
      }
      tickBoss(api, mob, target);
    },
  });

  // Spawn-on-demand command for GMs to test bosses.
  api.commands?.register?.({
    name: 'spawnboss',
    help: '[spawnboss <kind> — spawn a named boss at your position.',
    access: 'GameMaster',
    run(ctx) {
      const kind = String(ctx.args[0] ?? '').toLowerCase();
      const cfg = api.monsters.get(kind);
      if (!cfg || !cfg.boss) {
        ctx.state.sendSystemMessage(`Unknown boss kind '${kind}'.`);
        return;
      }
      const mob = spawnNPC(api, ctx.sender, {
        name: cfg.name, body: cfg.body, hue: 0,
        notoriety: cfg.notoriety ?? 6,
        invulnerable: false,
        kind: 'boss',
        fields: { kind, hp: cfg.hp, hpMax: cfg.hp },
      });
      if (mob && api.ai.attach) api.ai.attach(mob, 'boss');
      ctx.state.sendSystemMessage(`Spawned ${cfg.name}.`);
    },
  });

  return () => {};
}
