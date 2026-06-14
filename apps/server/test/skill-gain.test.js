// ServUO-style skill gain — bell curve peaks where skill ≈ difficulty,
// honors per-skill cap (120) and total cap (720).

import { describe, it, expect } from 'vitest';
import {
  gainChance, tryGain, SKILL_GAIN_CONST,
} from '../src/skill-gain.js';

describe('gainChance', () => {
  it('peaks when difficulty matches current skill', () => {
    const peak = gainChance(50, 50);
    expect(gainChance(50, 30)).toBeLessThan(peak);
    expect(gainChance(50, 70)).toBeLessThan(peak);
  });

  it('zero at the per-skill cap (no more gains past 120)', () => {
    expect(gainChance(SKILL_GAIN_CONST.SKILL_CAP_SINGLE, 100)).toBe(0);
  });

  it('zero when difficulty is more than 50 below current skill (too easy)', () => {
    expect(gainChance(80, 20)).toBe(0);   // distance = -60 → clamped, pct = 0
  });

  it('shrinks (but does not zero) as skill approaches cap from below', () => {
    const young = gainChance(10, 10);
    const old   = gainChance(100, 100);
    expect(old).toBeGreaterThan(0);
    expect(old).toBeLessThan(young);
  });
});

describe('tryGain', () => {
  it('returns null when rng > computed chance', () => {
    const m = { skills: { 41: 50 } };
    expect(tryGain(m, 41, 50, () => 0.999)).toBeNull();
    expect(m.skills[41]).toBe(50);
  });

  it('returns the new value when a gain happens', () => {
    const m = { skills: { 41: 50 } };
    expect(tryGain(m, 41, 50, () => 0)).toBe(51);
    expect(m.skills[41]).toBe(51);
  });

  it('accepts ServUO-style min/max skill ranges from scripts', () => {
    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      const m = { skills: { 41: 10 } };
      expect(tryGain(m, 41, -25, 60)).toBe(11);
      expect(m.skills[41]).toBe(11);
    } finally {
      Math.random = oldRandom;
    }
  });

  it('returns null at the per-skill cap', () => {
    const m = { skills: { 41: 120 } };
    expect(tryGain(m, 41, 100, () => 0)).toBeNull();
    expect(m.skills[41]).toBe(120);
  });

  it('returns null past the total-skills cap', () => {
    const m = { skills: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 120, 8: 100 } };
    // Total = 820 > 720. Even with rng=0, no skill should bump.
    expect(tryGain(m, 9, 50, () => 0)).toBeNull();
  });

  it('creates the skills map if missing and returns 1', () => {
    const m = {};
    expect(tryGain(m, 41, 0, () => 0)).toBe(1);
    expect(m.skills[41]).toBe(1);
  });

  it('handles a missing mob gracefully', () => {
    expect(tryGain(null, 41, 50, () => 0)).toBeNull();
  });
});
