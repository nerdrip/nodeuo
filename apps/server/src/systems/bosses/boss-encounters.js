// Unique boss encounter scripts — per-boss special mechanics that go
// beyond the generic peerless engine. Mirrors ServUO `Mobiles/Bosses/`
// override methods (`Medusa::PerformOnSwing`, `SlasherOfVeils::OnGotMeleeAttack`,
// `StygianDragon::OnGaveMeleeAttack`, etc.).
//
// Each entry registers a tick handler that runs every 1s on every
// in-world boss with `mob.boss?.encounter` matching. The handler can
// trigger AoE damage, status effects, summon adds, or self-buffs.

import { effectiveSkill } from '../../combat-formulas.js';

const _handlers = new Map();          // encounter tag → tick fn

export function registerBossEncounter(tag, fn) {
  if (!tag || typeof fn !== 'function') return;
  _handlers.set(tag, fn);
}

// Per-shard boss index lazily populated on first tick (walks once).
// Boss registration happens by stamping `mob.boss = { encounter: tag }`
// during spawn; spawn factory does that, AI hook adds serial here.
// Tick walks the Set (~handful) instead of all 11.7k mobiles.
function ensureBossIndex(world) {
  if (world._bosses instanceof Set) return world._bosses;
  const s = new Set();
  for (const mob of world.mobiles.values()) if (mob.boss?.encounter) s.add(mob.serial);
  world._bosses = s;
  return s;
}

export function tickBossEncounters(world, ctx) {
  if (!world?.mobiles) return;
  const idx = ensureBossIndex(world);
  for (const serial of [...idx]) {
    const mob = world.mobiles.get(serial);
    if (!mob || !mob.boss?.encounter) { idx.delete(serial); continue; }
    if ((mob.hp ?? 0) <= 0) continue;
    const fn = _handlers.get(mob.boss.encounter);
    if (!fn) continue;
    try { fn(world, mob, ctx); }
    catch (e) { console.error(`[boss-encounter ${mob.boss.encounter}]`, e?.message ?? e); }
  }
}

// =====================================================================
//  Helpers
// =====================================================================

function nearbyPlayers(world, boss, range) {
  const out = [];
  // Sector-aware lookup — bosses tick every 250 ms, walk-all-mobs was
  // a meaningful cost at populated-shard scale.
  const sectors = world.sectors;
  if (sectors?.mobileSerialsNear) {
    for (const s of sectors.mobileSerialsNear(boss.map, boss.x, boss.y, range)) {
      const m = world.mobiles.get(s);
      if (!m?.client || m.map !== boss.map) continue;
      if ((m.hp ?? 0) <= 0) continue;
      if (Math.max(Math.abs(m.x - boss.x), Math.abs(m.y - boss.y)) > range) continue;
      out.push(m);
    }
    return out;
  }
  for (const m of world.mobiles.values()) {
    if (!m.client) continue;
    if (m.map !== boss.map) continue;
    if ((m.hp ?? 0) <= 0) continue;
    if (Math.max(Math.abs(m.x - boss.x), Math.abs(m.y - boss.y)) > range) continue;
    out.push(m);
  }
  return out;
}

function damage(ctx, target, amount, attacker) {
  if (!target || amount <= 0) return;
  if (ctx?.applyDamage) {
    ctx.applyDamage(target, amount, 'physical', attacker);
  } else if (typeof target.hp === 'number') {
    target.hp = Math.max(0, target.hp - amount);
  }
}

function broadcastSpeech(ctx, mob, text) {
  ctx?.broadcastSpeech?.(mob, text);
}

// =====================================================================
//  MEDUSA — periodic stone-gaze (ServUO `Medusa.cs::DoGaze`).
//  Each player rolls vs ResistingSpells: failed roll = full petrify
//  (statue render, body 0x2DB / hue 0x47F, 8s frozen). Success = slow
//  + chip damage. ServUO uses a per-target line-of-sight cone check;
//  we collapse that to "must be facing the target in 8-tile arc".
// =====================================================================
registerBossEncounter('labyrinth', (world, boss, ctx) => {
  const now = Date.now();
  const nextAt = boss._gazeAt ?? 0;
  if (now < nextAt) return;
  boss._gazeAt = now + 8_000;
  const targets = nearbyPlayers(world, boss, 8);
  if (targets.length === 0) return;
  broadcastSpeech(ctx, boss, '*the Medusa\'s eyes flash a sickly green*');
  for (const t of targets) {
    // Eye contact required — if the player turned away, only slow.
    const dx = t.x - boss.x, dy = t.y - boss.y;
    const facingBack = (dx * Math.cos((t.direction ?? 0) * Math.PI / 4)
                     + dy * Math.sin((t.direction ?? 0) * Math.PI / 4)) > 0;
    const resist = effectiveSkill(t, 27);      // Resisting Spells
    const petrifyChance = Math.max(5, 45 - resist / 3);   // 45%@0 -> 5%@120
    const roll = Math.random() * 100;
    if (facingBack && roll < petrifyChance) {
      // Full petrify — render player as a statue for 8s. _petrifyUntil
      // is checked by render + combat; combat formulas treat the target
      // as fully frozen (no walk, no cast, no special).
      t._petrifyUntil = now + 8_000;
      t._petrifyBody = t.body;
      t._petrifyHue = t.hue;
      t.body = 0x2DB; t.hue = 0x47F;
      t._frozen = true;
      damage(ctx, t, 18 + Math.floor(Math.random() * 12), boss);
    } else {
      t._stoneSlowedUntil = now + 6_000;
      damage(ctx, t, 10 + Math.floor(Math.random() * 8), boss);
    }
  }
});

// Sweep loop for petrified players — restore body + hue after 8s window.
// Wired by boss-tick (medusa is the only consumer).
export function sweepPetrified(world) {
  const now = Date.now();
  for (const m of world.mobiles.values()) {
    if (!m._petrifyUntil || now < m._petrifyUntil) continue;
    if (m._petrifyBody !== undefined) m.body = m._petrifyBody;
    if (m._petrifyHue !== undefined) m.hue = m._petrifyHue;
    m._frozen = false;
    delete m._petrifyUntil;
    delete m._petrifyBody;
    delete m._petrifyHue;
  }
}

// =====================================================================
//  SLASHER OF VEILS — counter-strike on melee attacker (10% hp damage).
// =====================================================================
registerBossEncounter('underworld', (world, boss, ctx) => {
  const now = Date.now();
  const nextAt = boss._counterAt ?? 0;
  if (now < nextAt) return;
  // Pick the most recent attacker (set by combat tick on boss._lastAttacker).
  const attacker = boss._lastAttacker ? world.mobiles.get(boss._lastAttacker) : null;
  if (!attacker || (attacker.hp ?? 0) <= 0) return;
  boss._counterAt = now + 6_000;
  const dist = Math.max(Math.abs(attacker.x - boss.x), Math.abs(attacker.y - boss.y));
  if (dist > 2) return;
  const dmg = Math.floor((attacker.hpMax ?? 100) * 0.10);
  broadcastSpeech(ctx, boss, '*the veil tears! a shadow lashes back*');
  damage(ctx, attacker, dmg, boss);
});

// =====================================================================
//  STYGIAN DRAGON — 5-element breath rotation (fire/cold/poison/energy/
//  phys), 6s cycle. ServUO `StygianDragon.cs` rotates the breath each
//  swing; we tick every 6s and increment _breathIdx so the cycle is
//  predictable for skilled groups (run-away pattern).
// =====================================================================
const BREATH_CYCLE = [
  { type: 'fire',   text: 'belches black fire',       hue: 0x35 },
  { type: 'cold',   text: 'exhales freezing mist',    hue: 0x481 },
  { type: 'pois',   text: 'spits venomous bile',      hue: 0x44 },
  { type: 'engy',   text: 'unleashes lightning',      hue: 0x495 },
  { type: 'phys',   text: 'crushes with shockwave',   hue: 0x21 },
];

registerBossEncounter('stygian-dragon', (world, boss, ctx) => {
  const now = Date.now();
  // 5-element breath cone — 6s cycle, predictable rotation.
  if (now >= (boss._breathAt ?? 0)) {
    boss._breathAt = now + 6_000;
    boss._breathIdx = ((boss._breathIdx ?? 0) + 1) % BREATH_CYCLE.length;
    const breath = BREATH_CYCLE[boss._breathIdx];
    const facing = boss.direction ?? 0;
    const dirVec = [
      { x:  0, y: -1 }, { x:  1, y: -1 }, { x:  1, y:  0 }, { x:  1, y:  1 },
      { x:  0, y:  1 }, { x: -1, y:  1 }, { x: -1, y:  0 }, { x: -1, y: -1 },
    ];
    const fv = dirVec[(facing & 7)] ?? dirVec[0];
    broadcastSpeech(ctx, boss, `*the Stygian Dragon ${breath.text}*`);
    for (const t of nearbyPlayers(world, boss, 5)) {
      const dx = t.x - boss.x, dy = t.y - boss.y;
      const dot = dx * fv.x + dy * fv.y;
      if (dot <= 0) continue;
      const base = 25 + Math.floor(Math.random() * 15);
      if (ctx?.applyDamage) ctx.applyDamage(t, base, breath.type, boss);
      else damage(ctx, t, base, boss);
      // Type-specific rider effect.
      if (breath.type === 'pois')      { t._poisonUntil = now + 8_000; t._poisonLevel = 3; }
      else if (breath.type === 'cold') { t._stoneSlowedUntil = now + 4_000; }
      else if (breath.type === 'fire') { t._burnUntil = now + 3_000; }
    }
  }
  // Summon 2 Stygian imps every 30s.
  if (now >= (boss._summonAt ?? 0) && ctx?.spawnNearby) {
    boss._summonAt = now + 30_000;
    broadcastSpeech(ctx, boss, '*two imps coalesce from the smoke*');
    ctx.spawnNearby(boss, 'imp');
    ctx.spawnNearby(boss, 'imp');
  }
});

// NOTE: Travesty body-swap + mirror images live in peerless-bosses.js
// (registerBoss `travesty` onTick). Don't duplicate here.

// =====================================================================
//  PRIMEVAL LICH — graveyard tick: every 6s any corpse within 8 tiles
//  rises as a Skeleton minion until cleared.
// =====================================================================
registerBossEncounter('tomb-of-kings', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._raiseAt ?? 0)) return;
  boss._raiseAt = now + 6_000;
  if (!world.items?.values || !ctx?.spawnNearby) return;
  let raised = 0;
  // Sector-aware item scan — corpses are ground-tile items already
  // indexed by sectors. Walks ~handful of buckets instead of all 110k.
  // Bug-hunt #4 C.
  const sectors = world.sectors;
  const iter = sectors?.itemSerialsNear
    ? Array.from(sectors.itemSerialsNear(boss.map, boss.x, boss.y, 8), (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()];
  for (const it of iter) {
    if (it.kind !== 'corpse') continue;
    if (it.map !== boss.map) continue;
    if (Math.max(Math.abs(it.x - boss.x), Math.abs(it.y - boss.y)) > 8) continue;
    if (it._raisedByLich) continue;
    it._raisedByLich = true;
    ctx.spawnNearby(boss, 'skeleton');
    raised++;
    if (raised >= 3) break;
  }
  if (raised > 0) broadcastSpeech(ctx, boss, '*the dead heed their master*');
});

// =====================================================================
//  ABYSSAL INFERNAL — fire-field eruptions: spawn 4 short-lived flame
//  pillars in a cross pattern every 9s.
// =====================================================================
registerBossEncounter('fire-temple', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._eruptAt ?? 0)) return;
  boss._eruptAt = now + 9_000;
  broadcastSpeech(ctx, boss, '*flames erupt from the fissures*');
  const offsets = [[-2, 0], [2, 0], [0, -2], [0, 2]];
  for (const [dx, dy] of offsets) {
    for (const t of nearbyPlayers(world, boss, 0)) {
      if (t.x === boss.x + dx && t.y === boss.y + dy) {
        damage(ctx, t, 30 + Math.floor(Math.random() * 20), boss);
        t._burnUntil = now + 4_000;
      }
    }
  }
});

// =====================================================================
//  HARROWER — chooses a random nearby player every 4s and applies a
//  Curse-of-Suffering DoT (5 ticks of 8 dmg).
// =====================================================================
registerBossEncounter('harrower', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._curseAt ?? 0)) return;
  boss._curseAt = now + 4_000;
  const targets = nearbyPlayers(world, boss, 12);
  if (targets.length === 0) return;
  const victim = targets[Math.floor(Math.random() * targets.length)];
  victim._sufferingUntil = now + 5_000;
  victim._sufferingDmg = 8;
  broadcastSpeech(ctx, boss, `*${victim.name ?? 'a soul'} writhes under the Harrower's gaze*`);
});

// =====================================================================
//  CHIEF PAROXYSMUS — poison breath every 7s; spawn poison fields.
// =====================================================================
registerBossEncounter('paroxysmus', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._poisonAt ?? 0)) return;
  boss._poisonAt = now + 7_000;
  broadcastSpeech(ctx, boss, '*Paroxysmus exhales a corrupting mist*');
  for (const t of nearbyPlayers(world, boss, 6)) {
    t._poisonUntil = now + 12_000;
    t._poisonLevel = 4;
    damage(ctx, t, 18 + Math.floor(Math.random() * 8), boss);
  }
});

// =====================================================================
//  LADY MELISANDE — charm: a random target turns hostile to allies
//  for 10s. Sets `m._charmedBy = boss.serial`.
// =====================================================================
registerBossEncounter('blighted-grove', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._charmAt ?? 0)) return;
  boss._charmAt = now + 15_000;
  const targets = nearbyPlayers(world, boss, 8);
  if (targets.length === 0) return;
  const victim = targets[Math.floor(Math.random() * targets.length)];
  victim._charmedBy = boss.serial >>> 0;
  victim._charmedUntil = now + 10_000;
  broadcastSpeech(ctx, boss, `*${victim.name ?? 'one'} stands enthralled*`);
});

// =====================================================================
//  HARROWER — phase trigger at 75%/50%/25% HP. Each threshold spawns
//  a "tentacle" minion (kind: harrower-tentacle) and broadcasts the
//  phase. ServUO `Harrower.cs::OnDamage` mirrors this — every 25% it
//  speaks "The harrower writhes!" and adds.
// =====================================================================
registerBossEncounter('harrower-phases', (world, boss, ctx) => {
  const pct = (boss.hp ?? 1) / (boss.hpMax ?? 1);
  boss._harrowerPhase ??= 0;
  const thresholds = [0.75, 0.50, 0.25];
  for (let i = boss._harrowerPhase; i < thresholds.length; i++) {
    if (pct > thresholds[i]) break;
    boss._harrowerPhase = i + 1;
    broadcastSpeech(ctx, boss, '*The Harrower writhes! A tentacle bursts forth!*');
    const factory = ctx?.spawnFactory ?? world?._spawnFactory;
    if (factory) {
      for (let k = 0; k < 2; k++) {
        factory(world, 'harrower-tentacle', {
          x: boss.x + (k ? 1 : -1), y: boss.y + (k ? 1 : -1), z: boss.z, map: boss.map,
        });
      }
    }
  }
});

// =====================================================================
//  SLASHER OF VEILS — corruption rooms. Every 25s, pick a random
//  nearby player, teleport them to a tag-room (boss._roomAnchor +
//  offset 8,8) and stamp `_corruptionUntil`. ServUO `SlasherOfVeils.cs`
//  uses a fixed pool of 4 tagged rooms — we just offset by ±8 for MVP.
// =====================================================================
registerBossEncounter('slasher-of-veils-rooms', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._roomAt ?? 0)) return;
  boss._roomAt = now + 25_000;
  const targets = nearbyPlayers(world, boss, 12);
  if (targets.length === 0) return;
  const victim = targets[Math.floor(Math.random() * targets.length)];
  const dx = (Math.random() < 0.5 ? -8 : 8);
  const dy = (Math.random() < 0.5 ? -8 : 8);
  const nx = boss.x + dx, ny = boss.y + dy;
  // Teleport: mutate x/y + sectors.moveMobile per the project invariant.
  const sectors = world.sectors;
  const oldX = victim.x, oldY = victim.y;
  victim.x = nx; victim.y = ny;
  sectors?.moveMobile?.(victim, oldX, oldY);
  victim._corruptionUntil = now + 12_000;
  broadcastSpeech(ctx, boss, `*${victim.name ?? 'A soul'} is dragged into a veil-pocket!*`);
});

// =====================================================================
//  NIPORAILEM — Stygian Abyss niche boss. 3 abilities cycle every 8s:
//  sand-burst (12-tile AoE 20 dmg + slow), mass-fear (8-tile, _fearedUntil),
//  mineral burst (16 dmg energy to single target).
// =====================================================================
registerBossEncounter('niporailem', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._saAbilityAt ?? 0)) return;
  boss._saAbilityAt = now + 8_000;
  boss._saAbilityIdx = ((boss._saAbilityIdx ?? -1) + 1) % 3;
  const targets = nearbyPlayers(world, boss, 12);
  if (targets.length === 0) return;
  switch (boss._saAbilityIdx) {
    case 0:
      broadcastSpeech(ctx, boss, '*Niporailem stamps the ground — a sandstorm erupts!*');
      for (const t of targets) {
        damage(ctx, t, 18 + Math.floor(Math.random() * 6), boss);
        t._slowedUntil = now + 4_000;
      }
      return;
    case 1:
      broadcastSpeech(ctx, boss, '*Niporailem lets out a fearsome roar!*');
      for (const t of targets.slice(0, 6)) {
        t._fearedUntil = now + 5_000;
      }
      return;
    case 2: {
      const v = targets[0];
      damage(ctx, v, 28 + Math.floor(Math.random() * 8), boss);
      broadcastSpeech(ctx, boss, `*Mineral shards lance ${v.name ?? 'a soul'}!*`);
      return;
    }
  }
});

// =====================================================================
//  LORD OAKS — Heartwood boss. Vine-root every 10s on 1-3 targets;
//  at <30% HP starts spawning Treefellow adds (kind: treefellow).
// =====================================================================
registerBossEncounter('lord-oaks', (world, boss, ctx) => {
  const now = Date.now();
  if (now >= (boss._vineRootAt ?? 0)) {
    boss._vineRootAt = now + 10_000;
    const targets = nearbyPlayers(world, boss, 10).slice(0, 3);
    for (const t of targets) {
      t._rootedUntil = now + 4_000;
      t._frozen = true;
    }
    if (targets.length > 0) broadcastSpeech(ctx, boss, '*Vines erupt from the earth!*');
  }
  const pct = (boss.hp ?? 1) / (boss.hpMax ?? 1);
  if (pct < 0.30 && now >= (boss._summonFeyAt ?? 0)) {
    boss._summonFeyAt = now + 18_000;
    const factory = ctx?.spawnFactory ?? world?._spawnFactory;
    if (factory) {
      factory(world, 'treefellow', { x: boss.x + 1, y: boss.y + 1, z: boss.z, map: boss.map });
    }
    broadcastSpeech(ctx, boss, '*Lord Oaks calls his kin!*');
  }
});

// =====================================================================
//  LADY MEL — vine-root mass + summon swarm at low HP. Charm logic
//  remains in `blighted-grove` (different scene).
// =====================================================================
registerBossEncounter('lady-mel', (world, boss, ctx) => {
  const now = Date.now();
  if (now >= (boss._melRootAt ?? 0)) {
    boss._melRootAt = now + 12_000;
    for (const t of nearbyPlayers(world, boss, 8)) {
      t._rootedUntil = now + 3_000;
    }
    broadcastSpeech(ctx, boss, '*Lady Melisande binds her foes with thorny vines!*');
  }
  const pct = (boss.hp ?? 1) / (boss.hpMax ?? 1);
  if (pct < 0.40 && now >= (boss._melSwarmAt ?? 0)) {
    boss._melSwarmAt = now + 20_000;
    const factory = ctx?.spawnFactory ?? world?._spawnFactory;
    if (factory) {
      for (let i = 0; i < 3; i++) {
        factory(world, 'swarm-of-insects', {
          x: boss.x, y: boss.y + i - 1, z: boss.z, map: boss.map,
        });
      }
    }
  }
});

// =====================================================================
//  PRIMEVAL LICH — Pain-Spike chain (3 jumps) + Corpse-Skin AoE.
// =====================================================================
registerBossEncounter('primeval-lich', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._lichSpellAt ?? 0)) return;
  boss._lichSpellAt = now + 6_000;
  const targets = nearbyPlayers(world, boss, 10);
  if (targets.length === 0) return;
  // Pain-Spike chain — 3 jumps with diminishing damage.
  let pool = [...targets].sort(() => Math.random() - 0.5).slice(0, 3);
  for (let i = 0; i < pool.length; i++) {
    damage(ctx, pool[i], Math.max(8, 24 - i * 6), boss);
    pool[i]._painSpikeUntil = now + 3000;
  }
  // Corpse-Skin AoE on closer cluster — -15 fire/poison resist.
  for (const t of targets) {
    const d = Math.max(Math.abs(t.x - boss.x), Math.abs(t.y - boss.y));
    if (d <= 4) {
      t._corpseSkinUntil = now + 8_000;
      t._corpseSkinMalus = 15;
    }
  }
  broadcastSpeech(ctx, boss, '*The Primeval Lich chants — bones reshape!*');
});

// =====================================================================
//  ABYSSAL INFERNAL — at <40% HP, spawn fire orbs every 6s. Each orb
//  detonates after 3s for 30 dmg in 3-tile radius (kind: fire-orb).
// =====================================================================
registerBossEncounter('abyssal-infernal', (world, boss, ctx) => {
  const pct = (boss.hp ?? 1) / (boss.hpMax ?? 1);
  if (pct >= 0.40) return;
  const now = Date.now();
  if (now < (boss._orbAt ?? 0)) return;
  boss._orbAt = now + 6_000;
  broadcastSpeech(ctx, boss, '*The Abyssal Infernal erupts!*');
  // Schedule a deferred AoE.
  const targets = nearbyPlayers(world, boss, 8);
  for (const t of targets) {
    setTimeout(() => {
      if (!t || t.ghost) return;
      damage(ctx, t, 25 + Math.floor(Math.random() * 12), boss);
      t._burnUntil = (Date.now() + 4_000);
    }, 3_000);
  }
});

// =====================================================================
//  LURG (wisp variant) — lightning chain. Every 5s, chain-lightning
//  through up to 4 targets within 6 tiles, 14-22 energy dmg each,
//  diminishing 10% per jump.
// =====================================================================
registerBossEncounter('lurg', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._chainAt ?? 0)) return;
  boss._chainAt = now + 5_000;
  const targets = nearbyPlayers(world, boss, 6);
  if (targets.length === 0) return;
  let dmg = 18 + Math.floor(Math.random() * 5);
  for (const t of targets.slice(0, 4)) {
    damage(ctx, t, dmg, boss);
    dmg = Math.max(8, Math.floor(dmg * 0.90));
  }
  broadcastSpeech(ctx, boss, '*Lurg crackles with arcane lightning!*');
});

// =====================================================================
//  MALEFIC (necro variant) — frenzy mode. Every 4s, marks the nearest
//  player with _maleficMark + on-hit pain-spike rider for 8s.
// =====================================================================
registerBossEncounter('malefic', (world, boss, ctx) => {
  const now = Date.now();
  if (now < (boss._frenzyAt ?? 0)) return;
  boss._frenzyAt = now + 4_000;
  const targets = nearbyPlayers(world, boss, 10);
  if (targets.length === 0) return;
  let nearest = targets[0];
  let bestD = Infinity;
  for (const t of targets) {
    const d = Math.max(Math.abs(t.x - boss.x), Math.abs(t.y - boss.y));
    if (d < bestD) { bestD = d; nearest = t; }
  }
  nearest._maleficMark = now + 8_000;
  damage(ctx, nearest, 12 + Math.floor(Math.random() * 6), boss);
  broadcastSpeech(ctx, boss, `*Malefic fixates on ${nearest.name ?? 'a soul'}!*`);
});

export const BOSS_ENCOUNTER_TAGS = Object.freeze([
  ...new Set(_handlers.keys()),
]);
