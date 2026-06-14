// Poison — 5-level damage-over-time system. Port of ServUO
// `Scripts/Misc/Poison.cs` (PoisonImpl) adapted to our timer-less effect
// model in status-effects.js.
//
// Levels (ServUO AOS table):
//   0  Lesser    min=4  max=16  scalar=7.5   intervalMs=2250  count=10
//   1  Regular   min=8  max=18  scalar=10.0  intervalMs=3250  count=10
//   2  Greater   min=12 max=20  scalar=15.0  intervalMs=4250  count=10
//   3  Deadly    min=16 max=30  scalar=30.0  intervalMs=5250  count=15
//   4  Lethal    min=20 max=50  scalar=35.0  intervalMs=5250  count=20
//
// Each tick rolls min..max scaled by `scalar/100`. We don't reproduce
// the random "delay before first tick" — the effect ticks every
// `tickIntervalMs` set on the descriptor, with the first tick at apply
// time + intervalMs (status-effects.tickAll handles cadence).
//
// Cure chance (from PoisonImpl.GetMessageInterval / Cure path): higher
// poison levels are progressively harder to cure. We compute a
// per-attempt success chance keyed off the curing skill (Magery for
// `Cure` spell, Healing for bandage cure):
//   skill 0   → base
//   skill 100 → +0.55
// Returns 0..1 — caller does the roll.

import { apply, remove, has } from './status-effects.js';

/** @typedef {0|1|2|3|4} PoisonLevel */

// Poison level table — DEFAULT values preserved here for tests + safety
// in case scripts haven't loaded the JSON yet (engine boots usable).
// Live data is set via setPoisonTable(...) from
// apps/scripts/src/systems/poison.js (+ data/config/poison-levels.json).
/** @type {Array<{name:string,minDmg:number,maxDmg:number,scalar:number,intervalMs:number,count:number}>} */
let TABLE = [
  { name: 'Lesser',  minDmg: 4,  maxDmg: 16, scalar: 7.5,  intervalMs: 2250, count: 10 },
  { name: 'Regular', minDmg: 8,  maxDmg: 18, scalar: 10.0, intervalMs: 3250, count: 10 },
  { name: 'Greater', minDmg: 12, maxDmg: 20, scalar: 15.0, intervalMs: 4250, count: 10 },
  { name: 'Deadly',  minDmg: 16, maxDmg: 30, scalar: 30.0, intervalMs: 5250, count: 15 },
  { name: 'Lethal',  minDmg: 20, maxDmg: 50, scalar: 35.0, intervalMs: 5250, count: 20 },
];

/** Replace the poison level table. Called by scripts/systems/poison.js. */
export function setPoisonTable(table) {
  if (Array.isArray(table) && table.length === 5) TABLE = table.slice();
}

/** Hook for damage delivery — main.js wires this so the tick can apply
 *  HP loss + broadcast 0x77 health update. Without it the effect is a
 *  no-op (tests stub the listener directly). */
let _damageHook = null;
export function setDamageHook(fn) { _damageHook = fn; }

/** Deal `amount` to `mob`. Routes through the registered hook so combat
 *  visibility / death handling stays in one place. Falls back to direct
 *  mutation for unit tests. */
function _dealDamage(mob, amount, source = null) {
  if (_damageHook) {
    try { _damageHook(mob, amount, source); return; } catch { /* fall through */ }
  }
  mob.hp = Math.max(0, (mob.hp ?? mob.hits ?? 100) - amount);
}

/**
 * Apply poison of the given level to a mobile. Replaces any weaker poison
 * already attached; refuses to downgrade an active stronger poison.
 *
 * @param {*} mob
 * @param {PoisonLevel} level
 * @returns {boolean} true if the effect was attached / refreshed
 */
export function applyPoison(mob, level, source = null) {
  if (!mob) return false;
  // Audit #38 P1 #1 — Stone Form grants poison immunity. ServUO
  // `StoneFormSpell.CheckImmunity` short-circuits Poison.ApplyPoison.
  if (mob._stoneForm) return false;
  // Audit #38 P1 #2 — Evil Omen ups poison level by 1 then consumes.
  // ServUO `PoisonImpl.OnApply` reads `EvilOmen.TryEndEffect`.
  let lvlIn = level | 0;
  if ((mob.evilOmenUntil ?? 0) > Date.now()) {
    lvlIn += 1;
    mob.evilOmenUntil = 0;
  }
  const lvl = Math.max(0, Math.min(TABLE.length - 1, lvlIn));
  const def = TABLE[lvl];

  // Refuse to downgrade — stronger poison wins, weaker poison silently
  // bounces (mirrors ServUO Mobile.ApplyPoison behaviour where the
  // "you are already poisoned by a stronger poison" message fires).
  if (has(mob, 'poison')) {
    const cur = mob.effects?.find?.((e) => e.name === 'poison');
    // BH #13 B5 — equal-level poison no-op (ServUO "you are already
    // poisoned by an equal strength" message). Was `>` so equal-level
    // fell through to apply() which reset ticksRemaining to full count
    // → a 1-tick-left Regular poison could be refreshed for 10 more.
    if (cur && (cur.data?.level ?? 0) >= lvl) return false;
  }

  const totalMs = def.intervalMs * def.count;
  apply(mob, {
    name: 'poison',
    durationMs: totalMs,
    tickIntervalMs: def.intervalMs,
    data: { level: lvl, source: source?.serial ?? null, ticksRemaining: def.count },
    tick(target, world) {
      if (!target || target.hp <= 0) {
        remove(target, 'poison', world);
        return;
      }
      const e = target.effects?.find((x) => x.name === 'poison');
      const dmg = (def.minDmg + Math.floor(Math.random() * (def.maxDmg - def.minDmg + 1)))
                  * def.scalar / 100;
      const rounded = Math.max(1, Math.round(dmg));
      _dealDamage(target, rounded, source);
      if (e && e.data) e.data.ticksRemaining = (e.data.ticksRemaining ?? 0) - 1;
    },
    onRemove(target) {
      // ServUO clears the poisoned flag on m_Mobile when no Poison is
      // active — same here so the 0x77 status flag goes false.
      if (target) target.poisoned = false;
    },
  });
  // Compatibility flags consumed by older code (visibility, lore command).
  mob.poisoned = true;
  mob.poisonLevel = lvl;
  // Persistence stamp — the `effects[]` tick handler is a closure and
  // doesn't survive JSON serialisation. We persist the raw fields and
  // re-attach the timer on restoreWorld via `reapplyPoisonAfterRestore`.
  mob._poisonExpiresAt   = Date.now() + totalMs;
  mob._poisonSourceSerial = source?.serial ?? 0;
  return true;
}

/** Called by `world/persistence.js` after restoreWorld to re-attach the
 *  poison tick handler for every mobile that was poisoned at save time.
 *  Without this a player poisoned with Deadly logs out and back in
 *  completely cured. ServUO `Mobile.Deserialize` does the equivalent. */
export function reapplyPoisonAfterRestore(world, now = Date.now()) {
  let restored = 0;
  for (const mob of world.mobiles?.values?.() ?? []) {
    const exp = mob._poisonExpiresAt;
    const lvl = (mob.poisonLevel | 0);
    if (!exp || exp <= now || !mob.poisoned || lvl <= 0) {
      mob.poisoned = false;
      mob.poisonLevel = 0;
      mob._poisonExpiresAt = 0;
      continue;
    }
    // Re-run applyPoison so the timer + tick handler are restored. The
    // existing `effects[]` entry (none after restore — closures stripped)
    // is rebuilt; we manually shrink the duration to the remaining
    // window so a 9-second-into-Deadly poison doesn't refill to 16 s.
    const def = TABLE[lvl];
    if (!def) continue;
    const remainMs = exp - now;
    const remainingTicks = Math.max(1, Math.ceil(remainMs / def.intervalMs));
    apply(mob, {
      name: 'poison',
      durationMs: remainMs,
      tickIntervalMs: def.intervalMs,
      data: { level: lvl, source: mob._poisonSourceSerial ?? null, ticksRemaining: remainingTicks },
      tick(target) {
        if (!target || target.hp <= 0) { remove(target, 'poison', world); return; }
        const e = target.effects?.find((x) => x.name === 'poison');
        const dmg = (def.minDmg + Math.floor(Math.random() * (def.maxDmg - def.minDmg + 1)))
                    * def.scalar / 100;
        _dealDamage(target, Math.max(1, Math.round(dmg)), null);
        if (e && e.data) e.data.ticksRemaining = (e.data.ticksRemaining ?? 0) - 1;
      },
      onRemove(target) { if (target) target.poisoned = false; },
    });
    restored++;
  }
  return restored;
}

/**
 * Probability (0..1) that a cure attempt at the given skill (0..100)
 * succeeds against the current poison level on the target. Returns 0
 * if the target isn't poisoned. Source: ServUO PoisonImpl.GetMessageInterval +
 * Curse/Cure tables.
 *
 *   chance = (skill - minSkill) / range  + bonus
 *   level→{minSkill,range} table:
 *     0 → -10..40   (very forgiving)
 *     1 →   0..50
 *     2 →  20..60
 *     3 →  40..80
 *     4 →  60..100
 */
export function curingChance(mob, curingSkill = 0) {
  const e = mob?.effects?.find?.((x) => x.name === 'poison');
  if (!e) return 0;
  const lvl = e.data?.level ?? 0;
  const ranges = [
    { min: -10, max: 40 },
    { min:   0, max: 50 },
    { min:  20, max: 60 },
    { min:  40, max: 80 },
    { min:  60, max: 100 },
  ];
  const r = ranges[lvl] ?? ranges[ranges.length - 1];
  const span = r.max - r.min;
  const c = (curingSkill - r.min) / span;
  return Math.max(0, Math.min(1, c));
}

/**
 * Attempt to cure poison on `mob`. `curingSkill` is the skill driving
 * the attempt (Magery for Cure, Healing for bandage). Returns true on
 * success.
 */
export function attemptCure(mob, curingSkill = 100, world = null) {
  if (!has(mob, 'poison')) return true;          // nothing to cure
  const p = curingChance(mob, curingSkill);
  if (Math.random() < p) {
    remove(mob, 'poison', world);
    mob.poisoned = false;
    mob.poisonLevel = 0;
    return true;
  }
  return false;
}

/** Force-clear poison without a roll — used by Cleanse By Fire / GM. */
export function forceCure(mob, world = null) {
  if (remove(mob, 'poison', world)) {
    mob.poisoned = false;
    mob.poisonLevel = 0;
    return true;
  }
  return false;
}

/** Current poison level (0..4) or -1 if not poisoned. */
export function levelOf(mob) {
  const e = mob?.effects?.find?.((x) => x.name === 'poison');
  if (!e) return -1;
  return e.data?.level ?? 0;
}

/** Read-only table copy for tests / introspection. */
export function poisonTable() {
  return TABLE.map((row) => ({ ...row }));
}
