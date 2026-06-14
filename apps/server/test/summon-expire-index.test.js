import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { registerSummon, tickSummons } from '../src/systems/pets/summon-expire.js';

describe('summon expiry index', () => {
  it('lazy-builds the summon index from restored mobiles', () => {
    const world = new World();
    const summon = world.createMobile({
      name: 'old summon',
      body: 0x190,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
    });
    summon.summoned = true;
    summon.summonedUntil = Date.now() - 1000;

    tickSummons(world);

    expect(world.mobiles.has(summon.serial)).toBe(false);
    expect(world._summons?.has(summon.serial)).toBe(false);
    expect(world._summonIndexReady).toBe(true);
  });

  it('tracks summons created after the index is already warm', () => {
    const world = new World();
    tickSummons(world);

    const summon = world.createMobile({
      name: 'fresh summon',
      body: 0x190,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
    });
    summon.summoned = true;
    summon.summonedUntil = Date.now() - 1000;
    registerSummon(world, summon);

    tickSummons(world);

    expect(world.mobiles.has(summon.serial)).toBe(false);
    expect(world._summons?.has(summon.serial)).toBe(false);
  });
});
