// Coverage for the post-bug-hunt #6 combat-formulas readers — Discord
// damage bump, Peaceful/Disarm/Evasion hit-zero gates, effectiveStat
// helper. These weren't pinned down before, so a regression that drops
// the timer read would silently revert the bard / debuff content.

import { describe, it, expect } from 'vitest';
import {
  hitChance, rollDamage, effectiveStat,
} from '../src/combat-formulas.js';

const mkAttacker = (overrides = {}) => ({
  str: 100, dex: 100, int: 50, stam: 80, hp: 100, hpMax: 100,
  skills: { 41: 700, 28: 700 },
  ...overrides,
});
const mkDefender = (overrides = {}) => ({
  str: 80, dex: 80, int: 30, stam: 80, hp: 100, hpMax: 100,
  skills: { 41: 500, 28: 500 },
  ...overrides,
});

describe('effectiveStat', () => {
  it('returns raw stat without timers', () => {
    expect(effectiveStat({ str: 50 }, 'str')).toBe(50);
  });
  it('applies debuff while timer is live', () => {
    const m = { str: 80, strDebuffUntil: Date.now() + 5_000, strDebuff: 15 };
    expect(effectiveStat(m, 'str')).toBe(65);
  });
  it('default debuff magnitude is 10 if not specified', () => {
    const m = { dex: 90, dexDebuffUntil: Date.now() + 5_000 };
    expect(effectiveStat(m, 'dex')).toBe(80);
  });
  it('ignores expired debuff timer', () => {
    const m = { int: 70, intDebuffUntil: Date.now() - 1_000, intDebuff: 10 };
    expect(effectiveStat(m, 'int')).toBe(70);
  });
  it('applies buff while timer is live', () => {
    const m = { str: 80, strBuffUntil: Date.now() + 5_000, strBuff: 25 };
    expect(effectiveStat(m, 'str')).toBe(105);
  });
  it('default buff magnitude is 20', () => {
    const m = { dex: 80, dexBuffUntil: Date.now() + 5_000 };
    expect(effectiveStat(m, 'dex')).toBe(100);
  });
  it('clamps at 0', () => {
    const m = { str: 5, strDebuffUntil: Date.now() + 1_000, strDebuff: 50 };
    expect(effectiveStat(m, 'str')).toBe(0);
  });
});

describe('hitChance gates', () => {
  it('returns 0 when attacker is peaceful-locked', () => {
    const a = mkAttacker({ _peacefulUntil: Date.now() + 5_000 });
    expect(hitChance(a, mkDefender())).toBe(0);
  });
  it('ignores expired peaceful flag', () => {
    const a = mkAttacker({ _peacefulUntil: Date.now() - 1_000 });
    expect(hitChance(a, mkDefender())).toBeGreaterThan(0);
  });
  it('returns 0 when attacker is disarmed', () => {
    const a = mkAttacker({ _disarmedUntil: Date.now() + 5_000 });
    expect(hitChance(a, mkDefender())).toBe(0);
  });
  it('returns 0.02 when defender has Evasion buff', () => {
    const d = mkDefender({ _evasionUntil: Date.now() + 5_000 });
    expect(hitChance(mkAttacker(), d)).toBe(0.02);
  });
  it('applies feint DCI when defender has _feintUntil', () => {
    const baseline = hitChance(mkAttacker(), mkDefender());
    const withFeint = hitChance(
      mkAttacker(),
      mkDefender({ _feintUntil: Date.now() + 5_000 }),
    );
    expect(withFeint).toBeLessThan(baseline);
  });
});

describe('rollDamage Discord bump', () => {
  it('damage scales by (1 + _discordPenaltyPct) when defender is discorded', () => {
    const seedRng = () => 0.5;
    const attacker = mkAttacker({ str: 100 });
    const baseline = rollDamage(attacker, mkDefender(), seedRng);
    const discorded = rollDamage(attacker, mkDefender({
      _discordedUntil: Date.now() + 30_000,
      _discordPenaltyPct: 0.50,
    }), seedRng);
    expect(discorded).toBeGreaterThan(baseline);
  });
  it('uses default 30% bump when penalty not specified', () => {
    const seedRng = () => 0.5;
    const attacker = mkAttacker({ str: 100 });
    const baseline = rollDamage(attacker, mkDefender(), seedRng);
    const discorded = rollDamage(attacker, mkDefender({
      _discordedUntil: Date.now() + 30_000,
    }), seedRng);
    expect(discorded).toBeGreaterThanOrEqual(Math.floor(baseline * 1.20));
  });
  it('expired discord does NOT bump damage', () => {
    const seedRng = () => 0.5;
    const attacker = mkAttacker({ str: 100 });
    const baseline = rollDamage(attacker, mkDefender(), seedRng);
    const expired = rollDamage(attacker, mkDefender({
      _discordedUntil: Date.now() - 1_000,
      _discordPenaltyPct: 0.99,
    }), seedRng);
    expect(expired).toBe(baseline);
  });
});

describe('rollDamage uses effectiveStat for attacker Str', () => {
  it('weakened attacker swings lower than full-strength', () => {
    const seedRng = () => 0.5;
    const full = rollDamage(mkAttacker({ str: 100 }), mkDefender(), seedRng);
    const weak = rollDamage(mkAttacker({
      str: 100,
      strDebuffUntil: Date.now() + 5_000,
      strDebuff: 40,
    }), mkDefender(), seedRng);
    expect(weak).toBeLessThan(full);
  });
});
