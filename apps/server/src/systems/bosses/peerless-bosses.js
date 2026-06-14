// Peerless boss content — Stygian Dragon, Lord Oaks, Silvani, Medusa,
// Exodus. Mirrors ServUO `Mobiles/Bosses/`:
//
//   • Each boss has unique mechanics overlaid on the existing peerless
//     instance system (apps/server/src/systems/bosses/peerless.js).
//   • Mechanics are hooks: `onSpawn`, `onTick`, `onDamaged`, `onDeath`.
//     The combat loop calls these via `peerless.invokeHook(...)` if the
//     mob's `peerlessKey` matches one of the registered bosses.
//
// Stygian Dragon (Stygian Abyss):
//   - 4 phases: full HP, 75%, 50%, 25%
//   - Each phase swaps moveset: tail-sweep AOE → fire-breath cone →
//     claw-rake parry-piercing → wing-buffet stun
//   - Drops Stygian artifacts (Crimson Cincture, Conjurer's Trinket)
//
// Lord Oaks (Twisted Weald):
//   - Spawns lifestealing roots when below 50% HP
//   - Heals 10% HP every 30s if Silvani is alive nearby
//   - Drops Pixie Swatter, Acorn Cap of the Wood, Heartwood Helm
//
// Silvani (Twisted Weald):
//   - Pairs with Lord Oaks (mutual healing)
//   - AoE pollen cloud — confusion + slow
//   - Drops Pixie Swatter, Faerie Fire Cloak
//
// Medusa (Stygian Abyss):
//   - Petrify gaze: targets in cone get -50% spd for 8s
//   - Stoneform self-heal at 25% HP
//   - Drops Slither (ophidian-slayer slither boots)
//
// Exodus (Mythic Dungeon):
//   - 3 forms: Mechanical (immune to Necro), Energy (immune to Magery),
//     Animated (immune to physical). Players cycle damage type.
//   - Drops Exodus Sash, Cog of the Machine

const _bosses = new Map();             // peerlessKey → BossDef

/**
 * @typedef {Object} BossDef
 * @property {string} name
 * @property {string} kind                — monster kind id
 * @property {(boss:object, deps:object) => void} [onSpawn]
 * @property {(boss:object, dt:number, deps:object) => void} [onTick]
 * @property {(boss:object, attacker:object, dmg:number, deps:object) => number} [onDamaged]
 * @property {(boss:object, killer:object, deps:object) => void} [onDeath]
 * @property {string[]} artifacts        — drop pool
 */

function registerBoss(def) { _bosses.set(def.kind, def); }

function rollArtifact(def, rng = Math.random) {
  if (!def.artifacts?.length) return null;
  return def.artifacts[Math.floor(rng() * def.artifacts.length)];
}

// ---------------------------------------------------------------- Stygian Dragon
registerBoss({
  name: 'Stygian Dragon', kind: 'stygian-dragon',
  artifacts: ['crimson-cincture', 'conjurers-trinket', 'tangle', 'kirins-hoof'],
  onSpawn(boss) {
    boss.phase = 0;                     // 0..3
    boss.hpMax = boss.hpMax ?? 60_000;
    boss.hp = boss.hpMax;
    boss._cooldown = { breath: 0, sweep: 0, claw: 0, buffet: 0 };
  },
  onTick(boss, dt, deps) {
    if (!boss.hp || !boss.hpMax) return;
    const pct = boss.hp / boss.hpMax;
    boss.phase = pct > 0.75 ? 0 : pct > 0.5 ? 1 : pct > 0.25 ? 2 : 3;
    boss._cooldown.breath -= dt;
    boss._cooldown.sweep  -= dt;
    boss._cooldown.claw   -= dt;
    boss._cooldown.buffet -= dt;
    const targets = deps.findTargetsInRange?.(boss, 8) ?? [];
    if (boss.phase === 0 && boss._cooldown.sweep <= 0) {
      // Tail sweep — AoE 8 tiles, knockdown.
      for (const t of targets) deps.applyDamage?.(t, 35, 'physical', boss);
      boss._cooldown.sweep = 4000;
    }
    if (boss.phase === 1 && boss._cooldown.breath <= 0) {
      for (const t of targets) deps.applyDamage?.(t, 50, 'fire', boss);
      boss._cooldown.breath = 5000;
    }
    if (boss.phase === 2 && boss._cooldown.claw <= 0) {
      const t0 = targets[0];
      if (t0) deps.applyDamage?.(t0, 80, 'physical', boss);  // parry-piercing single
      boss._cooldown.claw = 3500;
    }
    if (boss.phase === 3 && boss._cooldown.buffet <= 0) {
      // Wing buffet — AoE stun.
      for (const t of targets) {
        deps.applyDamage?.(t, 20, 'physical', boss);
        deps.applyEffect?.(t, 'paralyze', 2000);
      }
      boss._cooldown.buffet = 6000;
    }
  },
  onDeath(boss, killer, deps) {
    const a = rollArtifact(this);
    if (a) deps.dropOnGround?.(boss, { artifact: a });
  },
});

// ---------------------------------------------------------------- Lord Oaks
registerBoss({
  name: 'Lord Oaks', kind: 'lord-oaks',
  artifacts: ['pixie-swatter', 'acorn-cap-of-the-wood', 'heartwood-helm'],
  onSpawn(boss) {
    boss.partner = null;
    boss._lastHeal = 0;
    boss.hpMax = boss.hpMax ?? 35_000;
    boss.hp = boss.hpMax;
  },
  onTick(boss, dt, deps) {
    boss._lastHeal += dt;
    // Spawn lifestealing roots below 50%.
    if (boss.hp / boss.hpMax < 0.5 && (!boss._roots || boss._roots.length < 4)) {
      boss._roots = boss._roots ?? [];
      const root = deps.spawnNearby?.(boss, 'parasitic-root');
      if (root) boss._roots.push(root.serial);
    }
    // Mutual heal with Silvani.
    if (boss._lastHeal >= 30_000) {
      boss._lastHeal = 0;
      const silvani = deps.findNearbyByKind?.(boss, 'silvani', 18);
      if (silvani && silvani.hp > 0) {
        boss.hp = Math.min(boss.hpMax, boss.hp + Math.floor(boss.hpMax * 0.10));
      }
    }
  },
});

// ---------------------------------------------------------------- Silvani
registerBoss({
  name: 'Silvani', kind: 'silvani',
  artifacts: ['pixie-swatter', 'faerie-fire-cloak', 'wildfire-bow'],
  onSpawn(boss) {
    boss.hpMax = boss.hpMax ?? 25_000;
    boss.hp = boss.hpMax;
    boss._lastPollen = 0;
  },
  onTick(boss, dt, deps) {
    boss._lastPollen += dt;
    if (boss._lastPollen >= 8_000) {
      boss._lastPollen = 0;
      const targets = deps.findTargetsInRange?.(boss, 6) ?? [];
      for (const t of targets) {
        deps.applyEffect?.(t, 'confusion', 4000);
        deps.applyEffect?.(t, 'slow',      4000);
      }
    }
  },
});

// ---------------------------------------------------------------- Medusa
registerBoss({
  name: 'Medusa', kind: 'medusa',
  artifacts: ['slither', 'venom-bow', 'medusas-blood'],
  onSpawn(boss) {
    boss.hpMax = boss.hpMax ?? 40_000;
    boss.hp = boss.hpMax;
    boss._stoned = false;
    boss._gazeReady = 0;
  },
  onTick(boss, dt, deps) {
    boss._gazeReady -= dt;
    if (boss._gazeReady <= 0) {
      boss._gazeReady = 7000;
      const cone = deps.findTargetsInCone?.(boss, 6, Math.PI / 3) ?? [];
      for (const t of cone) deps.applyEffect?.(t, 'petrify', 8000);
    }
    if (!boss._stoned && boss.hp / boss.hpMax < 0.25) {
      boss._stoned = true;
      // Stoneform — heal 25% over 5s.
      deps.applyHealOverTime?.(boss, Math.floor(boss.hpMax * 0.25), 5000);
    }
  },
});

// ---------------------------------------------------------------- Exodus
registerBoss({
  name: 'Exodus', kind: 'exodus',
  artifacts: ['exodus-sash', 'cog-of-the-machine', 'gargish-master-staff'],
  onSpawn(boss) {
    boss.hpMax = boss.hpMax ?? 50_000;
    boss.hp = boss.hpMax;
    boss._formIdx = 0;
    boss._immunities = [['necromancy'], ['magery'], ['physical']];
    boss._lastShift = 0;
  },
  onTick(boss, dt, deps) {
    boss._lastShift += dt;
    if (boss._lastShift >= 12_000) {
      boss._lastShift = 0;
      boss._formIdx = (boss._formIdx + 1) % 3;
      boss.immunities = boss._immunities[boss._formIdx];
      const formNames = ['mechanical', 'energy', 'animated'];
      deps.broadcastSpeech?.(boss, `* the form shifts to ${formNames[boss._formIdx]} *`);
    }
  },
  onDamaged(boss, attacker, dmg, deps) {
    // Reduce damage when type matches current immunity.
    const dmgType = deps.lastDamageType ?? 'physical';
    if (boss.immunities?.includes(dmgType)) return Math.floor(dmg * 0.1);
    return dmg;
  },
});

// ---------------------------------------------------------------- Travesty
// ServUO `Travesty.cs`: shape-shifts to mimic a randomly-chosen
// attacker every 30 s (body + name swap), summons mirror images at
// low HP, immune to Discord/Peace/Provoke. Loot drops the Travesty
// helm + a random ML artifact.
registerBoss({
  name: 'Travesty', kind: 'travesty',
  artifacts: ['midnight-bracers', 'crystalline-ring', 'mark-of-travesty'],
  onSpawn(boss) {
    boss.hp = boss.hpMax = boss.hpMax ?? 35_000;
    boss._origBody = boss.body;
    boss._origName = boss.name;
    boss._cooldown = { swap: 0, mirror: 0 };
    boss._mirrors = [];
    boss._immuneBard = true;          // Discord/Peace/Provoke noop
  },
  onTick(boss, dt, deps) {
    if (!boss.hp || !boss.hpMax) return;
    boss._cooldown.swap   -= dt;
    boss._cooldown.mirror -= dt;
    // Body-swap every 30 s — pick a random nearby attacker and
    // copy their body + name. Travesty becomes a living mirror.
    if (boss._cooldown.swap <= 0) {
      const targets = deps.findTargetsInRange?.(boss, 12) ?? [];
      if (targets.length > 0) {
        const victim = targets[Math.floor(Math.random() * targets.length)];
        boss.body = victim.body ?? boss._origBody;
        boss.name = `Travesty as ${victim.name ?? 'a foe'}`;
        deps.broadcastBodyChange?.(boss);
      } else {
        boss.body = boss._origBody;
        boss.name = boss._origName;
        deps.broadcastBodyChange?.(boss);
      }
      boss._cooldown.swap = 30_000;
    }
    // Low-HP mirror images — spawns three echo copies that share
    // 1/4 of remaining HP and deal half damage. Once per fight.
    if (!boss._spawnedMirrors && boss.hp < boss.hpMax * 0.3) {
      boss._spawnedMirrors = true;
      for (let i = 0; i < 3; i++) {
        const echo = deps.spawnNear?.(boss, {
          kind: 'travesty-echo',
          name: 'a mirror of Travesty',
          body: boss.body,
          hp: Math.floor(boss.hp / 4),
          hpMax: Math.floor(boss.hpMax / 4),
          str: Math.floor((boss.str ?? 950) / 2),
          dmgMin: 8, dmgMax: 12,
          notoriety: 6,
        });
        if (echo) boss._mirrors.push(echo.serial);
      }
    }
  },
  onDamaged(_boss, _attacker, dmg) { return dmg; },
  onDeath(boss, _killer, deps) {
    // Reset body before despawn so the corpse uses the canonical sprite.
    boss.body = boss._origBody ?? boss.body;
    const a = rollArtifact(this);
    if (a) deps.dropOnGround?.(boss, { artifact: a });
  },
});

// ---------------------------------------------------------------- Dark Father
// Doom Gauntlet final boss. Two-phase encounter — phase 1 he summons
// daemonic minions, phase 2 (under 50%) he stops summoning and gains
// a +50% damage frenzy.
registerBoss({
  name: 'Dark Father', kind: 'darkfather',
  artifacts: ['ring-of-the-vile', 'cloak-of-corruption', 'orc-chieftan-helm'],
  onSpawn(boss) {
    boss.hp = boss.hpMax = boss.hpMax ?? 25_000;
    boss._cooldown = { summon: 0, frenzy: 0 };
    boss.phase = 1;
  },
  onTick(boss, dt, deps) {
    if (!boss.hp || !boss.hpMax) return;
    boss._cooldown.summon  -= dt;
    boss._cooldown.frenzy  -= dt;
    const pct = boss.hp / boss.hpMax;
    const newPhase = pct > 0.5 ? 1 : 2;
    if (newPhase !== boss.phase) {
      boss.phase = newPhase;
      if (newPhase === 2) {
        boss._frenzyBonus = 0.5;            // +50% damage in onDamaged
        deps.broadcastSpeech?.(boss, 'Now you face my true wrath!');
      }
    }
    // Phase 1 — summon a daemonic minion every 12 s, max 4 alive.
    if (boss.phase === 1 && boss._cooldown.summon <= 0) {
      const alive = (boss._minions ?? []).filter((s) => deps.isAlive?.(s)).length;
      if (alive < 4) {
        const m = deps.spawnNear?.(boss, {
          kind: 'gibberling',
          name: 'a gibberling',
          hp: 200, hpMax: 200, str: 200, dmgMin: 8, dmgMax: 14,
          notoriety: 6,
        });
        if (m) {
          boss._minions ??= [];
          boss._minions.push(m.serial);
        }
      }
      boss._cooldown.summon = 12_000;
    }
  },
  onDamaged(boss, _attacker, dmg) {
    // Phase 2 frenzy applies to OUTGOING damage; this hook fires on
    // incoming. The frenzy bonus is read by the AI swing path when
    // the boss attacks (combat-formulas check on _frenzyBonus).
    return dmg;
  },
  onDeath(boss, _killer, deps) {
    const a = rollArtifact(this);
    if (a) deps.dropOnGround?.(boss, { artifact: a });
  },
});

// ----------------------------------------------------------------

export function getBossDef(kind) { return _bosses.get(kind) ?? null; }
export function allBosses() { return [..._bosses.values()]; }

/**
 * Tick all live bosses in `world`. Called from main.js on a 250ms cadence.
 * Expensive O(N) over world.mobiles; we early-out on non-bosses.
 */
export function tickBosses(world, dt, deps = {}) {
  // Server parity #8 #8 — lazy `world._peerlessBosses` Set built once
  // (filtered by `_bosses.has(kind)`) so the 250ms tick walks ~handful
  // of registered peerless mobs instead of every mobile on the shard
  // (was the same cost as bard-skills before its sectorisation).
  if (!world._peerlessBosses) {
    const s = new Set();
    for (const m of world.mobiles.values()) {
      if (m?.kind && _bosses.has(m.kind)) s.add(m.serial);
    }
    world._peerlessBosses = s;
  }
  for (const serial of [...world._peerlessBosses]) {
    const m = world.mobiles.get(serial);
    if (!m || !m.kind || !_bosses.has(m.kind)) {
      world._peerlessBosses.delete(serial);
      continue;
    }
    const def = _bosses.get(m.kind);
    if ((m.hp ?? 0) <= 0) continue;
    if (!m._bossInited) { def.onSpawn?.(m); m._bossInited = true; }
    def.onTick?.(m, dt, deps);
  }
}

/** Add a freshly-spawned boss to the tick index. Call from spawn paths
 *  that introduce a peerless mob (champion / instance / GM spawn). */
export function registerBossInstance(world, mob) {
  if (!world || !mob?.kind || !_bosses.has(mob.kind)) return;
  if (!world._peerlessBosses) world._peerlessBosses = new Set();
  world._peerlessBosses.add(mob.serial);
}

/** Hook combat death: invoke onDeath if the mob is a registered peerless. */
export function invokeBossDeath(victim, killer, deps = {}) {
  const def = _bosses.get(victim?.kind);
  if (!def) return false;
  def.onDeath?.(victim, killer, deps);
  return true;
}

/** Hook damage: invoke onDamaged if applicable. Returns possibly-modified damage. */
export function invokeBossDamaged(victim, attacker, dmg, deps = {}) {
  const def = _bosses.get(victim?.kind);
  if (!def?.onDamaged) return dmg;
  return def.onDamaged(victim, attacker, dmg, deps) ?? dmg;
}
