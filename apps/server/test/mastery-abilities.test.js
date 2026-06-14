import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { invokeMastery } from '../src/systems/mastery-abilities.js';

describe('mastery abilities', () => {
  it('SummonReaper creates a controlled temporary summon instead of a flag-only marker', () => {
    const world = new World();
    const caster = world.createMobile({
      x: 100,
      y: 100,
      z: 0,
      map: 1,
      mana: 100,
      manaMax: 100,
    });

    const result = invokeMastery(world, caster, null, 'SummonReaper');

    expect(result.ok).toBe(true);
    expect(caster.mana).toBe(35);
    expect(caster._reaperUntil).toBeGreaterThan(Date.now());
    const reaper = [...world.mobiles.values()].find((m) => m.kind === 'summoned-reaper');
    expect(reaper).toBeTruthy();
    expect(reaper).toMatchObject({
      controlMaster: caster.serial,
      summoned: true,
      summonedBy: caster.serial,
      ai: 'pet',
    });
    expect(reaper.summonedUntil).toBeGreaterThan(Date.now());
    expect(world._summons?.has(reaper.serial)).toBe(true);
  });
});
