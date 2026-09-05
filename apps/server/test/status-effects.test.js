// Status-effects module: apply/remove/tick with DoT semantics.
// Uses vi.useFakeTimers only for the Date.now source — tickAll is a pure
// function taking `now`, so we can advance time by passing explicit values.

import { describe, it, expect } from 'vitest';
import * as statusEffects from '../src/status-effects.js';

function makeMob(overrides = {}) {
  return { serial: 0x1001, hp: 100, hpMax: 100, effects: [], ...overrides };
}
function makeWorld(mobs) {
  return { mobiles: new Map(mobs.map((m) => [m.serial, m])) };
}

describe('statusEffects.apply', () => {
  it('attaches an effect and fills defaults', () => {
    const mob = makeMob();
    const eff = statusEffects.apply(mob, { name: 'bless', durationMs: 5000 });
    expect(mob.effects).toHaveLength(1);
    expect(mob.effects[0].name).toBe('bless');
    expect(eff.expiresAt).toBeGreaterThan(Date.now());
  });

  it('replaces an existing effect of the same name (refresh semantics)', () => {
    const mob = makeMob();
    const removed = [];
    statusEffects.apply(mob, { name: 'poison', durationMs: 1000, onRemove: () => removed.push('a') });
    statusEffects.apply(mob, { name: 'poison', durationMs: 10_000, onRemove: () => removed.push('b') });
    expect(mob.effects).toHaveLength(1);
    expect(removed).toEqual(['a']); // first effect's onRemove fires when replaced
  });
});

describe('statusEffects.has / remove', () => {
  it('has returns true when the effect is active', () => {
    const mob = makeMob();
    statusEffects.apply(mob, { name: 'poison', durationMs: 5000 });
    expect(statusEffects.has(mob, 'poison')).toBe(true);
    expect(statusEffects.has(mob, 'bless')).toBe(false);
  });

  it('remove drops the effect and fires onRemove', () => {
    const mob = makeMob();
    let fired = false;
    statusEffects.apply(mob, { name: 'poison', durationMs: 5000, onRemove: () => { fired = true; } });
    const ok = statusEffects.remove(mob, 'poison');
    expect(ok).toBe(true);
    expect(fired).toBe(true);
    expect(mob.effects).toHaveLength(0);
  });

  it('remove returns false when there is no such effect', () => {
    const mob = makeMob();
    expect(statusEffects.remove(mob, 'poison')).toBe(false);
  });
});

describe('statusEffects.tickAll', () => {
  it('fires tick() at the configured interval', () => {
    const mob = makeMob();
    const ticks = [];
    statusEffects.apply(mob, {
      name: 'poison', durationMs: 10_000, tickIntervalMs: 2000,
      lastTickAt: 0,
      tick: (_m, _w, now) => ticks.push(now),
    });
    const world = makeWorld([mob]);
    statusEffects.tickAll(world, 1000); // too early, lastTickAt=0 → (1000-0) >= 2000? no
    statusEffects.tickAll(world, 2000); // 2000 >= 2000 → fires
    statusEffects.tickAll(world, 3000); // 3000-2000 = 1000 < 2000 → no
    statusEffects.tickAll(world, 4500); // 4500-2000 = 2500 >= 2000 → fires
    expect(ticks).toEqual([2000, 4500]);
  });

  it('expires and removes effects past their deadline', () => {
    const mob = makeMob();
    let removed = false;
    statusEffects.apply(mob, {
      name: 'poison',
      expiresAt: 5000,
      onRemove: () => { removed = true; },
    });
    const world = makeWorld([mob]);
    statusEffects.tickAll(world, 4000);
    expect(mob.effects).toHaveLength(1);
    statusEffects.tickAll(world, 5000);
    expect(mob.effects).toHaveLength(0);
    expect(removed).toBe(true);
  });

  it('applies DoT damage over time (end-to-end poison simulation)', () => {
    const mob = makeMob({ hp: 50 });
    statusEffects.apply(mob, {
      name: 'poison',
      expiresAt: 10_000,
      tickIntervalMs: 2000,
      lastTickAt: 0,
      tick: (m) => { m.hp -= 5; },
    });
    const world = makeWorld([mob]);
    for (let t = 0; t <= 10_000; t += 500) statusEffects.tickAll(world, t);
    // 5 ticks total (at 2000, 4000, 6000, 8000, 10000) — but 10000 hits
    // expiry before tick fires. So 4 ticks of 5 dmg = 20.
    // Actual: lastTickAt starts at 0, so tick 1 at t=2000, tick 2 at 4000,
    // tick 3 at 6000, tick 4 at 8000; at t=10000 expiresAt hits first.
    expect(mob.hp).toBeLessThanOrEqual(30);
    expect(mob.hp).toBeGreaterThanOrEqual(25);
    expect(statusEffects.has(mob, 'poison')).toBe(false);
  });

  it('waits one full interval in production time and indexes the mobile', () => {
    const world = { mobiles: new Map(), _mobsWithEffects: new Set() };
    const mob = makeMob({ _world: world });
    world.mobiles.set(mob.serial, mob);
    const ticks = [];
    const appliedAt = Date.now();
    statusEffects.apply(mob, {
      name: 'renewal', durationMs: 10_000, tickIntervalMs: 2_000,
      tick: (_mob, _world, now) => ticks.push(now),
    });
    expect(world._mobsWithEffects.has(mob.serial)).toBe(true);
    statusEffects.tickAll(world, appliedAt + 1_999);
    expect(ticks).toEqual([]);
    statusEffects.tickAll(world, appliedAt + 2_000);
    expect(ticks).toEqual([appliedAt + 2_000]);
    statusEffects.remove(mob, 'renewal', world);
    expect(world._mobsWithEffects.has(mob.serial)).toBe(false);
  });
});
