import { hitChance, rollDamage, swingDelayMs } from '../combat-formulas.js';

function cloneCombatant(mob) {
  if (!mob) return null;
  const copy = { ...mob };
  copy.skills = { ...(mob.skills ?? {}) };
  copy.attributes = { ...(mob.attributes ?? {}) };
  copy.effects = (mob.effects ?? []).map((effect) => ({ ...effect, data: { ...(effect.data ?? {}) } }));
  copy._equipment = (mob._equipment ?? []).map((item) => ({ ...item }));
  copy._weapon = mob._weapon ? { ...mob._weapon } : null;
  if (mob._weapon?.damageBreakdown) copy._weapon.damageBreakdown = { ...mob._weapon.damageBreakdown };
  copy.specializations = mob.specializations
    ? { earned: mob.specializations.earned, allocations: { ...(mob.specializations.allocations ?? {}) } } : undefined;
  return copy;
}

function seeded(seed = 0x9E3779B9) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

export function simulateCombat(attackerMob, defenderMob, { trials = 5000, seed = 1 } = {}) {
  if (!attackerMob || !defenderMob) return { ok: false, error: 'attacker and defender are required' };
  const count = Math.max(100, Math.min(100_000, trials | 0));
  const rng = seeded(seed);
  const chance = hitChance(cloneCombatant(attackerMob), cloneCombatant(defenderMob));
  const samples = [];
  let hits = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (rng() > chance) { samples.push(0); continue; }
    const damage = rollDamage(cloneCombatant(attackerMob), cloneCombatant(defenderMob), rng);
    hits++; total += damage; samples.push(damage);
  }
  samples.sort((a, b) => a - b);
  const delayMs = swingDelayMs(cloneCombatant(attackerMob), attackerMob?._weapon?.speed ?? 30);
  const averagePerSwing = total / count;
  const dps = averagePerSwing / (delayMs / 1000);
  const hp = Math.max(1, defenderMob.hpMax ?? defenderMob.hp ?? 1);
  return {
    ok: true, trials: count, seed: seed >>> 0,
    attacker: { serial: attackerMob.serial >>> 0, name: attackerMob.name ?? '' },
    defender: { serial: defenderMob.serial >>> 0, name: defenderMob.name ?? '', hp },
    hitChance: chance,
    observedHitRate: hits / count,
    swingDelayMs: delayMs,
    damage: {
      averageOnHit: hits ? total / hits : 0,
      averagePerSwing,
      min: samples.find((value) => value > 0) ?? 0,
      median: percentile(samples, 0.50),
      p90: percentile(samples, 0.90),
      p99: percentile(samples, 0.99),
      max: samples[samples.length - 1] ?? 0,
    },
    dps,
    estimatedTtkSeconds: dps > 0 ? hp / dps : null,
  };
}
