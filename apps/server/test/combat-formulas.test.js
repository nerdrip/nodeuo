// Combat formulas — pure-function unit tests. These are the only place we
// pin down the curves; any future tuning that breaks these assertions will
// surface here loudly instead of as silent gameplay drift.

import { describe, it, expect } from 'vitest';
import {
  hitChance, rollDamage, swingDelayMs,
  unarmedDamageRange, damageMultiplier,
  applyArmor, armorRating,
  effectiveSkill, effectiveWeaponSkill,
  applyConfidenceParryStamina,
  WEAPON_SKILLS, SKILL_TACTICS, SKILL_ANATOMY, SKILL_PARRYING, SKILL_BUSHIDO,
} from '../src/combat-formulas.js';

const mob = (overrides = {}) => ({
  str: 50, dex: 50, int: 50, stam: 50, hp: 50, hpMax: 50,
  ...overrides,
});

describe('effectiveSkill', () => {
  it('reads numeric skill ids', () => {
    const m = mob({ skills: { 26: 75 } });
    expect(effectiveSkill(m, 26)).toBe(75);
  });

  it('also reads string skill ids (skills survive JSON round-trips that way)', () => {
    const m = mob({ skills: { '26': 75 } });
    expect(effectiveSkill(m, 26)).toBe(75);
  });

  it('normalizes legacy tenths scale from old saves', () => {
    const m = mob({ skills: { 26: 1000 } });
    expect(effectiveSkill(m, 26)).toBe(100);
  });

  it('returns 0 for missing skills, missing skills dict, missing mob', () => {
    expect(effectiveSkill(mob(), 26)).toBe(0);
    expect(effectiveSkill(null, 26)).toBe(0);
    expect(effectiveSkill(mob({ skills: {} }), 26)).toBe(0);
  });
});

describe('effectiveWeaponSkill', () => {
  it('picks the highest weapon skill', () => {
    const m = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 30, [WEAPON_SKILLS.SWORDSMANSHIP]: 90 } });
    expect(effectiveWeaponSkill(m)).toBe(90);
  });

  it('falls back to mob.weaponSkill for skill-less monsters', () => {
    expect(effectiveWeaponSkill(mob({ weaponSkill: 65 }))).toBe(65);
  });

  it('uses the wielded weapon skill instead of the highest unrelated skill', () => {
    expect(effectiveWeaponSkill(mob({
      _weapon: { skill: WEAPON_SKILLS.ARCHERY },
      skills: { [WEAPON_SKILLS.ARCHERY]: 40, [WEAPON_SKILLS.SWORDSMANSHIP]: 120 },
    }))).toBe(40);
  });

  it('returns 0 for a wholly untrained mobile', () => {
    expect(effectiveWeaponSkill(mob())).toBe(0);
  });
});

describe('hitChance', () => {
  it('produces ~0.5 when attacker == defender', () => {
    const a = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 50 } });
    const d = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 50 } });
    expect(hitChance(a, d)).toBeCloseTo(0.5, 5);
  });

  it('clamps to a minimum of 2% so even hopelessly outclassed fighters can land a hit', () => {
    const a = mob();
    const d = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 120 } });
    expect(hitChance(a, d)).toBeGreaterThanOrEqual(0.02);
    expect(hitChance(a, d)).toBeLessThan(0.5);
  });

  it('caps at 100% — no overflow even with extreme attacker skill', () => {
    const a = mob({ skills: { [WEAPON_SKILLS.SWORDSMANSHIP]: 1000 } });
    const d = mob();
    expect(hitChance(a, d)).toBeLessThanOrEqual(1.0);
  });

  it('treats Parrying as the defender skill when higher than weapon skill (with shield)', () => {
    const a = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 50 } });
    const dWeak = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 20 } });
    // PHASE HK: parry skill counts only when the defender has a shield
    // equipped (`_hasShield = true`). The unshielded equivalent below
    // confirms the gate works.
    const dParry = mob({
      skills: { [WEAPON_SKILLS.WRESTLING]: 20, [SKILL_PARRYING]: 90 },
      _hasShield: true,
    });
    expect(hitChance(a, dParry)).toBeLessThan(hitChance(a, dWeak));
  });

  it('ignores Parrying when no shield is equipped (PHASE HK / #125)', () => {
    const a = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 50 } });
    const dNoShield = mob({
      skills: { [WEAPON_SKILLS.WRESTLING]: 20, [SKILL_PARRYING]: 90 },
      // _hasShield NOT set — parry skill should be ignored.
    });
    const dWeak = mob({ skills: { [WEAPON_SKILLS.WRESTLING]: 20 } });
    expect(hitChance(a, dNoShield)).toBe(hitChance(a, dWeak));
  });
});

describe('unarmedDamageRange', () => {
  it('grows monotonically with strength', () => {
    expect(unarmedDamageRange(0)).toEqual({ lo: 1, hi: 4 });
    expect(unarmedDamageRange(40)).toEqual({ lo: 2, hi: 5 });
    expect(unarmedDamageRange(80)).toEqual({ lo: 3, hi: 6 });
    expect(unarmedDamageRange(120)).toEqual({ lo: 4, hi: 7 });
  });

  it('treats negative or undefined str as 0', () => {
    expect(unarmedDamageRange(-50)).toEqual({ lo: 1, hi: 4 });
    expect(unarmedDamageRange(undefined)).toEqual({ lo: 1, hi: 4 });
  });
});

describe('damageMultiplier', () => {
  it('starts at 1 + str/300 with no skills', () => {
    expect(damageMultiplier(mob({ str: 60 }))).toBeCloseTo(1.2, 2);
  });

  it('jumps with maxed Tactics+Anatomy', () => {
    const m = mob({ str: 100, skills: { [SKILL_TACTICS]: 100, [SKILL_ANATOMY]: 100 } });
    // 1 + 100*0.00625 + 100*0.005 + 100/300 = 1 + 0.625 + 0.5 + 0.333 ≈ 2.46
    expect(damageMultiplier(m)).toBeCloseTo(2.458, 2);
  });
});

describe('applyArmor', () => {
  it('reduces damage linearly up to a 70% cap', () => {
    expect(applyArmor(100, 0)).toBe(100);
    expect(applyArmor(100, 50)).toBe(50);
    expect(applyArmor(100, 70)).toBe(30);
    expect(applyArmor(100, 200)).toBe(30); // capped
  });

  it('always leaves at least 1 damage so an immortal-armor target is impossible', () => {
    expect(applyArmor(1, 200)).toBe(1);
    expect(applyArmor(0, 0)).toBe(1);
  });
});

describe('armorRating', () => {
  it('sums inherent + equipped pieces', () => {
    const m = mob({ armor: 5, _equipment: [{ ar: 10 }, { ar: 7 }, {}] });
    expect(armorRating(m)).toBe(22);
  });

  it('handles bare mobs', () => {
    expect(armorRating(mob())).toBe(0);
    expect(armorRating(null)).toBe(0);
  });
});

describe('rollDamage', () => {
  it('uses the injected RNG so tests are deterministic', () => {
    const a = mob({ str: 100, skills: { [SKILL_TACTICS]: 100, [SKILL_ANATOMY]: 100 } });
    const d = mob({ armor: 0 });
    // rng=0 → bottom of range, rng→1 → top of range
    const lo = rollDamage(a, d, () => 0);
    const hi = rollDamage(a, d, () => 0.999);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThanOrEqual(1);
  });

  it('respects defender armor', () => {
    const a = mob({ str: 80 });
    const naked = rollDamage(a, mob(), () => 0.5);
    const armored = rollDamage(a, mob({ armor: 50 }), () => 0.5);
    expect(armored).toBeLessThan(naked);
  });

  it('rolls the equipped weapon damage range instead of unarmed damage', () => {
    const a = mob({ str: 0, _weapon: { minDamage: 20, maxDamage: 28 } });
    expect(rollDamage(a, mob({ armor: 0 }), () => 0)).toBe(20);
    expect(rollDamage(a, mob({ armor: 0 }), () => 0.999)).toBe(28);
  });
});

describe('swingDelayMs', () => {
  it('clamps to [1250, 10000]', () => {
    expect(swingDelayMs(mob({ stam: 0 }), 1)).toBeLessThanOrEqual(10000);
    expect(swingDelayMs(mob({ stam: 200 }), 5)).toBeGreaterThanOrEqual(1250);
  });

  it('higher stam → faster swings', () => {
    const slow = swingDelayMs(mob({ stam: 20 }), 30);
    const fast = swingDelayMs(mob({ stam: 100 }), 30);
    expect(fast).toBeLessThan(slow);
  });

  it('higher weaponSpeed → faster swings', () => {
    const heavy = swingDelayMs(mob({ stam: 50 }), 25);
    const light = swingDelayMs(mob({ stam: 50 }), 56);
    expect(light).toBeLessThan(heavy);
  });

  it('reads AOS speed directly from the equipped weapon by default', () => {
    const dagger = swingDelayMs(mob({ stam: 50, _weapon: { speed: 56 } }));
    const halberd = swingDelayMs(mob({ stam: 50, _weapon: { speed: 25 } }));
    expect(dagger).toBe(2000);
    expect(halberd).toBe(5000);
  });
});

describe('applyConfidenceParryStamina', () => {
  it('restores stamina while Confidence is waiting for a parry', () => {
    const m = mob({
      stam: 20,
      stamMax: 50,
      _confidenceStamRegen: true,
      skills: { [SKILL_BUSHIDO]: 100 },
    });

    const gained = applyConfidenceParryStamina(m);

    expect(gained).toBe(18);
    expect(m.stam).toBe(38);
  });

  it('does nothing without the Confidence marker or above stamina cap', () => {
    expect(applyConfidenceParryStamina(mob({ stam: 20, stamMax: 50 }))).toBe(0);
    expect(applyConfidenceParryStamina(mob({
      stam: 50,
      stamMax: 50,
      _confidenceStamRegen: true,
      skills: { [SKILL_BUSHIDO]: 100 },
    }))).toBe(0);
  });
});
