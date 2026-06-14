// Basic AI-scheduler tests: stepMobile respects land walkability via
// landProvider (no tiledata loaded -> permissive), and the scheduler
// exposes it on the instance for scripts.

import { describe, it, expect, vi } from 'vitest';

// Force a flat-grass world so the test doesn't accidentally land on real
// map water (ocean fills (100,100) in Felucca, which would now reject the
// step thanks to the impassable-land check in resolveCardinalStep).
vi.mock('../src/world/land-provider.js', () => ({
  landProvider: {
    landAt: () => ({ z: 0, tileId: 3 }),
    staticsAt: () => [],
  },
}));

const { AIScheduler, stepMobile } = await import('../src/world/ai.js');
const { World } = await import('../src/world/world.js');

describe('AI stepMobile', () => {
  it('turns the mobile when facing changes', () => {
    const world = new World();
    const mob = world.createMobile({ x: 100, y: 100, z: 0, map: 1, direction: 0 });
    const moved = stepMobile(mob, 2); // east
    expect(moved).toBe(true);
    expect(mob.direction & 7).toBe(2);
    // Only turned — position unchanged.
    expect(mob.x).toBe(100);
    expect(mob.y).toBe(100);
  });

  it('steps one tile when facing already matches', () => {
    const world = new World();
    const mob = world.createMobile({ x: 100, y: 100, z: 0, map: 1, direction: 2 });
    const moved = stepMobile(mob, 2); // east
    expect(moved).toBe(true);
    expect(mob.x).toBe(101);
    expect(mob.y).toBe(100);
  });

  it('AIScheduler.stepMobile delegates to the module function', () => {
    const world = new World();
    const ai = new AIScheduler(world, {
      mobileMovingPacket: () => new Uint8Array(),
      unicodeSpeechPacket: () => new Uint8Array(),
    });
    const mob = world.createMobile({ x: 50, y: 50, z: 0, map: 1, direction: 4 });
    expect(typeof ai.stepMobile).toBe('function');
    ai.stepMobile(mob, 4); // south — already facing, so step
    expect(mob.y).toBe(51);
  });
});
