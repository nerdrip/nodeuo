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

const { AIScheduler, stepMobile, wanderBehavior } = await import('../src/world/ai.js');
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

  it('wander AI follows a facing turn with the intended step next tick', () => {
    const world = new World();
    const mob = world.createMobile({ x: 100, y: 100, z: 0, map: 1, direction: 0 });
    const state = {
      home: { x: 100, y: 100 },
      nextStepAt: 0,
      pendingDirection: 2,
    };
    const broadcasts = [];
    const ctx = { world, now: 100, broadcastMove: (m) => broadcasts.push([m.x, m.y]) };

    wanderBehavior.tick(ctx, mob, state);
    expect([mob.x, mob.y, mob.direction]).toEqual([100, 100, 2]);
    expect(state.pendingDirection).toBe(2);
    ctx.now = state.nextStepAt;
    wanderBehavior.tick(ctx, mob, state);
    expect([mob.x, mob.y]).toEqual([101, 100]);
    expect(state.pendingDirection).toBeNull();
    expect(broadcasts).toHaveLength(2);
  });

  it('does not tick or re-broadcast the backing creature while mounted', () => {
    const world = new World();
    const ai = new AIScheduler(world, {
      mobileMovingPacket: () => new Uint8Array(),
      unicodeSpeechPacket: () => new Uint8Array(),
    });
    let ticks = 0;
    ai.registerBehavior({ name: 'mount-test', tick: () => { ticks++; } });
    const horse = world.createMobile({ x: 10, y: 10, z: 0, map: 1 });
    horse.mounted = true;
    ai.attach(horse, 'mount-test');

    ai._tickAll();

    expect(ticks).toBe(0);
    expect(ai.diagnostics.get(horse.serial)?.status).toBe('mounted');
  });

  it('bounds work per pulse and advances the cursor fairly', () => {
    const world = new World();
    const ai = new AIScheduler(world, {
      mobileMovingPacket: () => new Uint8Array(),
      unicodeSpeechPacket: () => new Uint8Array(),
      maxTicksPerPulse: 2,
      tickBudgetMs: 1_000,
    });
    const seen = [];
    ai.registerBehavior({ name: 'budget-test', tick: (_ctx, mob) => seen.push(mob.serial) });
    const mobs = Array.from({ length: 5 }, (_, index) => world.createMobile({
      x: 10 + index, y: 10, z: 0, map: 1,
    }));
    for (const mob of mobs) ai.attach(mob, 'budget-test');

    ai._tickAll();
    expect(seen).toEqual(mobs.slice(0, 2).map((mob) => mob.serial));
    ai._tickAll();
    expect(seen).toEqual(mobs.slice(0, 4).map((mob) => mob.serial));
    expect(ai.schedulerDiagnostics.pulses).toBe(2);
  });
});
