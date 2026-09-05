// PHASE CZ — teleporter lifecycle script: walking on a teleporter
// tile moves the mobile to the destination, broadcasts mobileUpdate
// to self + mobileMoving to nearby observers.

import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  registerItemScript, unregisterItemScript, dispatchItemEvent,
} from '../src/world/item-scripts.js';
import buildTeleporterScript from '../../scripts/src/items/scripts/world/teleporter.js';

describe('teleporter script (PHASE CZ)', () => {
  /** @type {World} */ let w;
  /** @type {any} */ let mob;
  /** @type {any[]} */ let mobSent;
  /** @type {any} */ let observer;
  /** @type {any[]} */ let observerSent;

  beforeEach(() => {
    w = new World();
    registerItemScript(buildTeleporterScript());
    mob = w.createMobile({ name: 'tester', body: 0x190, x: 50, y: 50, z: 0, map: 1 });
    mobSent = [];
    mob.client = { send: (b) => mobSent.push(b), sendSystemMessage: () => {} };
    observer = w.createMobile({ name: 'witness', body: 0x190, x: 200, y: 200, z: 0, map: 1 });
    observerSent = [];
    observer.client = { send: (b) => observerSent.push(b) };
  });
  afterEach(() => unregisterItemScript('teleporter'));

  it('moves the mobile to teleportTo on walkOn', () => {
    const tele = createItem(w, { itemId: 0x1BC3, x: 50, y: 50, z: 0, map: 1 });
    tele.script = 'teleporter';
    tele.teleportTo = { x: 200, y: 200, z: 0, map: 1 };
    dispatchItemEvent(w, tele, 'onWalkOn', mob);
    expect(mob.x).toBe(200);
    expect(mob.y).toBe(200);
    // Self gets 0x20 mobileUpdate.
    expect(mobSent.some((b) => b[0] === 0x20)).toBe(true);
  });

  it('cross-map teleport changes mob.map', () => {
    const tele = createItem(w, { itemId: 0x1BC3, x: 50, y: 50, z: 0, map: 1 });
    tele.script = 'teleporter';
    tele.teleportTo = { x: 1000, y: 1000, z: 0, map: 0 };
    dispatchItemEvent(w, tele, 'onWalkOn', mob);
    expect(mob.map).toBe(0);
  });

  it('broadcasts mobileMoving to observers near the destination', () => {
    const tele = createItem(w, { itemId: 0x1BC3, x: 50, y: 50, z: 0, map: 1 });
    tele.script = 'teleporter';
    tele.teleportTo = { x: 200, y: 200, z: 0, map: 1 };
    dispatchItemEvent(w, tele, 'onWalkOn', mob);
    expect(observerSent.some((b) => b[0] === 0x77)).toBe(true);
  });

  it('rejects non-player mobs when item.creatures = false', () => {
    const tele = createItem(w, { itemId: 0x1BC3, x: 50, y: 50, z: 0, map: 1 });
    tele.script = 'teleporter';
    tele.teleportTo = { x: 200, y: 200, z: 0, map: 1 };
    tele.creatures = false;
    const npc = w.createMobile({ name: 'orc', body: 0xB1, x: 50, y: 50, z: 0, map: 1 });
    dispatchItemEvent(w, tele, 'onWalkOn', npc);
    // Mob position unchanged.
    expect(npc.x).toBe(50);
  });

  it('no-op when item.teleportTo is missing', () => {
    const tele = createItem(w, { itemId: 0x1BC3, x: 50, y: 50, z: 0, map: 1 });
    tele.script = 'teleporter';
    dispatchItemEvent(w, tele, 'onWalkOn', mob);
    expect(mob.x).toBe(50);   // unchanged
  });

  it('uses the central teleport path and refreshes the destination asynchronously', () => {
    const queued = [];
    const refreshes = [];
    const calls = [];
    const script = buildTeleporterScript({
      game: {
        mobile: {
          teleport(target, dest, options) {
            calls.push({ target, dest, options });
            Object.assign(target, dest);
            return { mapChanged: false };
          },
        },
      },
      ctx: { handlers: { refreshSurroundings: (state) => refreshes.push(state) } },
      lifecycle: { setImmediate: (fn) => queued.push(fn) },
    });
    const tele = createItem(w, { itemId: 0x1BCB, x: 50, y: 50, z: 0, map: 1 });
    tele.script = 'teleporter';
    tele.teleportTo = { x: 210, y: 211, z: 2, map: 1 };

    expect(script.onWalkOn(w, tele, mob)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.refresh).toBe(false);
    expect([mob.x, mob.y, mob.z]).toEqual([210, 211, 2]);
    expect(refreshes).toHaveLength(0);
    expect(queued).toHaveLength(1);
    queued[0]();
    expect(refreshes).toEqual([mob.client]);
  });

  it('does not blanket-block an unrelated chained teleporter', () => {
    const script = buildTeleporterScript();
    const first = createItem(w, { itemId: 0x1BCB, x: 50, y: 50, z: 0, map: 1 });
    first.teleportTo = { x: 200, y: 200, z: 0, map: 1 };
    const second = createItem(w, { itemId: 0x1BCB, x: 201, y: 200, z: 0, map: 1 });
    second.teleportTo = { x: 300, y: 300, z: 0, map: 1 };

    expect(script.onWalkOn(w, first, mob)).toBe(true);
    mob.x = second.x; mob.y = second.y;
    expect(script.onWalkOn(w, second, mob)).toBe(true);
    expect([mob.x, mob.y]).toEqual([300, 300]);
  });
});

import { afterEach } from 'vitest';
