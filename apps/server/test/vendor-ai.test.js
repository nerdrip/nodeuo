// Vendor NPC behavior: wanders within a short leash around its home and
// greets passing players on a per-player cooldown. Shares the direct-tick
// pattern used in healer-ai.test.js / mage-ai.test.js.

import { describe, it, expect, beforeEach } from 'vitest';
import registerVendor from '../../scripts/src/npcs/vendors/vendor.js';

function makeApi(world) {
  let behavior = null;
  const stepped = [];
  return {
    world,
    log: () => {},
    ai: {
      registerBehavior(b) { behavior = b; },
      unregisterBehavior() {},
      attach() {},
      stepMobile(mob, dir) {
        stepped.push({ serial: mob.serial, dir });
        // Treat every direction as walkable — the scheduler already handles
        // the movement-math path in production; this test only cares that
        // the behavior issued a step.
        mob.direction = dir & 7;
        return true;
      },
    },
    items: { createItem: () => ({}), destroyItem: () => {} },
    protocol: {
      mobileIncoming: () => new Uint8Array([0x78]),
      containerContentUpdate: () => new Uint8Array([0x25]),
      removeEntity: () => new Uint8Array([0x1D]),
    },
    commands: { register: () => {}, unregister: () => {} },
    vendors: { register: () => {} },
    _behavior: () => behavior,
    _stepped: stepped,
  };
}

function makeWorld() { return { mobiles: new Map(), items: new Map() }; }

describe('vendor NPC behavior', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let vendor;
  /** @type {any} */ let state;
  /** @type {any} */ let behavior;
  /** @type {string[]} */ let spoken;
  /** @type {number[]} */ let moved;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerVendor(api);
    behavior = api._behavior();
    vendor = {
      serial: 0x4100, x: 100, y: 100, z: 0, map: 1,
      body: 0x0190, direction: 0, hue: 0x83EA, notoriety: 1,
    };
    world.mobiles.set(vendor.serial, vendor);
    state = behavior.initState();
    spoken = [];
    moved = [];
  });

  function tick(now) {
    behavior.tick({
      world, now,
      broadcastMove: (m) => { moved.push(m.serial); },
      broadcastSpeech: (_m, text) => { spoken.push(text); },
    }, vendor, state);
  }

  it('locks in a home on the first tick', () => {
    tick(1000);
    expect(state.home).toEqual({ x: 100, y: 100 });
  });

  it('greets a nearby player and remembers them on cooldown', () => {
    const player = {
      serial: 0x5101, x: 102, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(player.serial, player);

    tick(1000);
    expect(spoken.length).toBe(1);
    const firstLine = spoken[0];

    // Same tick window — no second greeting.
    tick(2000);
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toBe(firstLine);

    // Still inside the 45s per-player cooldown.
    tick(40_000);
    expect(spoken.length).toBe(1);

    // Past the cooldown — greet again.
    tick(60_000);
    expect(spoken.length).toBe(2);
  });

  it('ignores players out of range', () => {
    const faraway = {
      serial: 0x5102, x: 120, y: 120, z: 0, map: 1,
      notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(faraway.serial, faraway);
    tick(1000);
    expect(spoken).toHaveLength(0);
  });

  it('faces the greeted player', () => {
    const player = {
      serial: 0x5103, x: 103, y: 100, z: 0, map: 1,
      notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(player.serial, player);
    tick(1000);
    // Player is due East (dx=+1, dy=0) → direction 2.
    expect(vendor.direction).toBe(2);
  });

  it('wanders when no player is nearby', () => {
    // Arm the step clock so the behavior wants to move immediately.
    state.nextStepAt = 0;
    tick(1000);
    expect(api._stepped.length).toBe(1);
    expect(moved).toContain(vendor.serial);
  });

  it('heads back toward home when drifted past the leash', () => {
    state.home = { x: 100, y: 100 };
    state.nextStepAt = 0;
    vendor.x = 110; vendor.y = 100; // 10 tiles east of home
    tick(1000);
    // atan2(0, -10) = PI → direction 6 (W). Accept 5..7 for rounding.
    expect(api._stepped.length).toBe(1);
    const dir = api._stepped[0].dir;
    expect([5, 6, 7]).toContain(dir);
  });

  it('skips ghosts when picking a greet target', () => {
    const ghost = {
      serial: 0x5104, x: 101, y: 100, z: 0, map: 1,
      notoriety: 1, ghost: true, client: { send: () => {} },
    };
    world.mobiles.set(ghost.serial, ghost);
    tick(1000);
    expect(spoken).toHaveLength(0);
  });
});
