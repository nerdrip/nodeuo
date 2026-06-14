// Tests for poison.js — 5-level damage-over-time + cure rolls.

import { describe, it, expect, beforeEach } from 'vitest';
import * as poison from '../src/poison.js';
import * as effects from '../src/status-effects.js';

function makeMob(over = {}) {
  return {
    serial: 1, name: 'test', hp: 100, hpMax: 100,
    map: 0, x: 0, y: 0, z: 0,
    ...over,
  };
}

describe('poison system', () => {
  beforeEach(() => {
    poison.setDamageHook(null);
  });

  it('refuses to downgrade an active stronger poison', () => {
    const m = makeMob();
    expect(poison.applyPoison(m, 3)).toBe(true);
    expect(poison.levelOf(m)).toBe(3);
    // try to downgrade — should silently fail
    expect(poison.applyPoison(m, 0)).toBe(false);
    expect(poison.levelOf(m)).toBe(3);
    // upgrade is allowed
    expect(poison.applyPoison(m, 4)).toBe(true);
    expect(poison.levelOf(m)).toBe(4);
  });

  it('runs a damage tick through the registered hook', () => {
    const m = makeMob();
    let dmg = 0;
    poison.setDamageHook((target, amount) => { dmg += amount; target.hp -= amount; });
    poison.applyPoison(m, 0);
    // Force a tick by walking the effect via tickAll with advanced clock.
    const eff = m.effects[0];
    eff.tick(m, null, Date.now());
    expect(dmg).toBeGreaterThan(0);
    expect(m.hp).toBeLessThan(100);
  });

  it('curing chance scales with skill', () => {
    const m = makeMob();
    poison.applyPoison(m, 2);
    expect(poison.curingChance(m, 0)).toBe(0);
    expect(poison.curingChance(m, 100)).toBeCloseTo(1, 1);
    expect(poison.curingChance(m, 30)).toBeGreaterThan(0);
  });

  it('forceCure removes the effect unconditionally', () => {
    const m = makeMob();
    poison.applyPoison(m, 4);
    expect(poison.levelOf(m)).toBe(4);
    expect(poison.forceCure(m)).toBe(true);
    expect(poison.levelOf(m)).toBe(-1);
    expect(m.poisoned).toBe(false);
  });

  it('ticking purges poison when target dies', () => {
    const m = makeMob({ hp: 1 });
    poison.setDamageHook((target, amount) => { target.hp = Math.max(0, target.hp - amount); });
    poison.applyPoison(m, 4);
    const eff = m.effects[0];
    eff.tick(m, null, Date.now());
    // After a damage tick that kills the target the next tick removes it.
    eff.tick(m, null, Date.now());
    expect(effects.has(m, 'poison')).toBe(false);
  });
});
