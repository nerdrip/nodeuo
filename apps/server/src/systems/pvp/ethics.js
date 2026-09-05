// Ethics — Hero/Evil PvP alignment system. Port of ServUO
// `Scripts/Services/Ethics/` (BaseEthic.cs, Hero.cs, Evil.cs, Powers.cs).
//
// Players can join one of two factions:
//   Hero   — defenders of virtue. PvP buffs for fighting Evil.
//   Evil   — anarchic. PvP buffs for fighting Hero or unaligned criminals.
//
// Joining requires 5000 fame (Hero) or 5000 karma (negative for Evil).
// Power tiers (Apprentice / Adept / Master / Lord) unlock spells:
//   Hero: Honor Strike, Shield of Protection, Awareness, Vehemence
//   Evil: Despoil, Curse, Blast, Dread
//
// We persist alignment on `mob.ethic` ('hero' | 'evil' | null) plus
// `mob.ethicPower` (0..1000 currency for spell costs).

const TIERS = Object.freeze([
  { name: 'Initiate',   minPower:    0 },
  { name: 'Apprentice', minPower:  200 },
  { name: 'Adept',      minPower:  400 },
  { name: 'Master',     minPower:  700 },
  { name: 'Lord',       minPower: 1000 },
]);

const HERO_FAME_GATE = 5000;
const EVIL_KARMA_GATE = -5000;
const POWER_CAP = 1000;

/** Return null if `mob` is not aligned, otherwise 'hero' | 'evil'. */
export function alignmentOf(mob) {
  return mob?.ethic ?? null;
}

/** Tier struct based on `mob.ethicPower` (0..1000). */
export function tierOf(mob) {
  const p = mob?.ethicPower ?? 0;
  let best = TIERS[0];
  for (const t of TIERS) if (p >= t.minPower) best = t;
  return best;
}

/**
 * Attempt to join `mob` to `side`. Fails if requirements unmet or already aligned.
 * Returns { ok, reason }.
 */
export function join(mob, side) {
  if (!mob) return { ok: false, reason: 'no-mob' };
  if (mob.ethic) return { ok: false, reason: 'already-aligned' };
  if (side === 'hero') {
    if ((mob.fame ?? 0) < HERO_FAME_GATE) return { ok: false, reason: 'low-fame' };
  } else if (side === 'evil') {
    if ((mob.karma ?? 0) > EVIL_KARMA_GATE) return { ok: false, reason: 'low-karma' };
  } else {
    return { ok: false, reason: 'bad-side' };
  }
  mob.ethic = side;
  mob.ethicPower = 0;
  mob.ethicJoinedAt = Date.now();
  return { ok: true };
}

/** Leave the ethic — drops alignment, keeps fame/karma. */
export function leave(mob) {
  if (!mob?.ethic) return false;
  delete mob.ethic;
  delete mob.ethicPower;
  delete mob.ethicJoinedAt;
  return true;
}

/** Award (or subtract) ethic power. Returns the new value. */
export function awardPower(mob, amount) {
  if (!mob?.ethic) return 0;
  mob.ethicPower = Math.max(0, Math.min(POWER_CAP, (mob.ethicPower ?? 0) + (amount | 0)));
  return mob.ethicPower;
}

/** Two mobiles are PvP-eligible under ethics rules if they're on
 *  opposite sides. Same-side aligned mobs cannot duel through ethics. */
export function canEthicAttack(attacker, defender) {
  const a = alignmentOf(attacker);
  const d = alignmentOf(defender);
  if (!a || !d) return false;
  return a !== d;
}

/** Spell catalogue per side. Each entry: { id, name, minTier, cost,
 *  effect(caster, target) } — caster pays cost in ethicPower.
 *
 *  Effects follow ServUO `Engines/Ethics/Hero/Powers/*` and
 *  `Engines/Ethics/Evil/Powers/*`. We mirror the canonical durations
 *  and damage values; combat-formulas reads the flags below
 *  (ethicHonorUntil → next-swing crit, ethicShieldUntil → -50% damage
 *  taken, ethicAwareUntil → reveal hidden in range 8, ethicRageUntil
 *  → +50% damage dealt and -10% defense, ethicCurseUntil → -20%
 *  damage dealt, ethicDreadUntil → 25% chance to miss target). */
export const HERO_POWERS = Object.freeze([
  { id: 'honor-strike',  name: 'Honor Strike',     minTier: 1, cost: 50,
    effect: (caster /* , target */) => {
      // ServUO: next swing within 6 s deals +50% damage and +25% on
      // hit chance against Evil-aligned defenders.
      caster.ethicHonorUntil = Date.now() + 6_000;
    } },
  { id: 'shield-of-protection', name: 'Shield of Protection', minTier: 2, cost: 80,
    effect: (caster) => {
      // -50% incoming damage for 60 s.
      caster.ethicShieldUntil = Date.now() + 60_000;
      caster.ethicShieldFactor = 0.5;
    } },
  { id: 'awareness',     name: 'Awareness',        minTier: 3, cost: 120,
    effect: (caster, _target, world) => {
      // Reveals hidden mobs in range 8 for 120 s; combat-formulas
      // hitChance skips stealth penalties while active.
      caster.ethicAwareUntil = Date.now() + 120_000;
      for (const mob of world?.mobiles?.values?.() ?? []) {
        if (mob === caster || mob.map !== caster.map || !mob.hidden) continue;
        if (Math.max(Math.abs(mob.x - caster.x), Math.abs(mob.y - caster.y)) <= 8) {
          mob.hidden = false;
        }
      }
    } },
  { id: 'vehemence',     name: 'Vehemence',        minTier: 4, cost: 200,
    effect: (caster) => {
      // +50% damage / -10% defense for 30 s — berserker rage.
      caster.ethicRageUntil = Date.now() + 30_000;
      caster.ethicRageBonus = 0.5;
      caster.ethicRageDefenseMalus = 0.1;
    } },
]);

export const EVIL_POWERS = Object.freeze([
  { id: 'despoil',  name: 'Despoil',  minTier: 1, cost: 50, requiresTarget: true,
    effect: (caster, target) => {
      // Marks the target so the next time anyone (caster's allies
      // included) kills them, gold drop is doubled. 60 s window.
      if (target) target.ethicDespoilUntil = Date.now() + 60_000;
    } },
  { id: 'curse',    name: 'Curse',    minTier: 2, cost: 80, requiresTarget: true,
    effect: (caster, target) => {
      // Target deals -20% damage for 30 s. combat-formulas reads
      // ethicCurseUntil + ethicCurseMalus.
      if (target) {
        target.ethicCurseUntil = Date.now() + 30_000;
        target.ethicCurseMalus = 0.2;
      }
    } },
  { id: 'blast',    name: 'Blast',    minTier: 3, cost: 120, requiresTarget: true,
    effect: (caster, target, world) => {
      // Direct 25..40 damage, energy-typed. Routed through the
      // combat damage hook so it triggers aggression + on-hit procs.
      if (!target) return;
      const dmg = 25 + Math.floor(Math.random() * 16);
      if (world?._combat?.damage) {
        try { world._combat.damage(world, target, dmg, caster); }
        catch { /* advisory */ }
      } else {
        target.hp = Math.max(0, (target.hp ?? 1) - dmg);
      }
    } },
  { id: 'dread',    name: 'Dread',    minTier: 4, cost: 200,
    effect: (caster) => {
      // Aura: attackers swinging at caster have 25% chance to miss
      // for 60 s. combat-formulas hitChance reads ethicDreadUntil.
      caster.ethicDreadUntil = Date.now() + 60_000;
      caster.ethicDreadMissChance = 0.25;
    } },
]);

/** Find a power on the caster's side. */
export function findPower(mob, powerId) {
  const list = mob?.ethic === 'evil' ? EVIL_POWERS : HERO_POWERS;
  return list.find((p) => p.id === powerId) ?? null;
}

/** Try to invoke `powerId` from `mob`. Returns { ok, reason }.
 *  Check order: unaligned → unknown-power → no-power → tier-too-low.
 *  Power deficit reads as the most actionable signal ("you need to
 *  earn more by killing enemies"); tier requirement is a permanent
 *  gate that's only relevant when the player has the power to spend. */
export function invokePower(mob, powerId, target = null, world = null) {
  if (!mob?.ethic) return { ok: false, reason: 'unaligned' };
  const power = findPower(mob, powerId);
  if (!power) return { ok: false, reason: 'unknown-power' };
  if (power.requiresTarget && !target) return { ok: false, reason: 'missing-target' };
  if ((mob.ethicPower ?? 0) < power.cost) return { ok: false, reason: 'no-power' };
  const tier = tierOf(mob);
  const tierIdx = TIERS.indexOf(tier);
  if (tierIdx < power.minTier) return { ok: false, reason: 'tier-too-low' };
  mob.ethicPower -= power.cost;
  try { power.effect(mob, target, world); }
  catch {
    mob.ethicPower = Math.min(POWER_CAP, mob.ethicPower + power.cost);
    return { ok: false, reason: 'effect-failed' };
  }
  return { ok: true, power };
}

export function listTiers() { return TIERS.map((t) => ({ ...t })); }
