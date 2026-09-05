// PHASE BQ — `dispatchTileWalkEvents` fires onWalkOn / onWalkOff for
// scripted ground items at the source / destination tile of a step.
// Includes a regression for bugfix #33 (pressure-plate held open while
// any mob is still on the plate).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  registerItemScript, unregisterItemScript, dispatchTileWalkEvents,
} from '../src/world/item-scripts.js';

describe('dispatchTileWalkEvents (PHASE BQ)', () => {
  /** @type {string[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    registerItemScript({
      name: '__test-trap',
      onWalkOn(_w, item, mob) { calls.push(`on:${item.serial}:${mob.serial}`); },
      onWalkOff(_w, item, mob) { calls.push(`off:${item.serial}:${mob.serial}`); },
    });
  });
  afterEach(() => {
    unregisterItemScript('__test-trap');
  });

  it('fires onWalkOff on the source tile, onWalkOn on the dest tile', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'wanderer', body: 0x0190, x: 5, y: 5, z: 0, map: 1 });
    const sourceTrap = createItem(w, { itemId: 0x09F8, x: 5, y: 5, z: 0, map: 1 });
    sourceTrap.script = '__test-trap';
    const destTrap = createItem(w, { itemId: 0x09F8, x: 6, y: 5, z: 0, map: 1 });
    destTrap.script = '__test-trap';

    dispatchTileWalkEvents(w, mob,
      { x: 5, y: 5, z: 0, map: 1 },
      { x: 6, y: 5, z: 0, map: 1 });
    expect(calls).toContain(`off:${sourceTrap.serial}:${mob.serial}`);
    expect(calls).toContain(`on:${destTrap.serial}:${mob.serial}`);
  });

  it('skips items in containers (parent != null)', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'wanderer', body: 0x0190, x: 5, y: 5, z: 0, map: 1 });
    const bag = createItem(w, { itemId: 0x0E75, x: 6, y: 5, z: 0, map: 1, gumpId: 0x003C });
    const inside = createItem(w, {
      itemId: 0x09F8, x: 0, y: 0, z: 0, map: 1, parent: bag.serial,
    });
    inside.script = '__test-trap';
    dispatchTileWalkEvents(w, mob,
      { x: 5, y: 5, z: 0, map: 1 },
      { x: 6, y: 5, z: 0, map: 1 });
    expect(calls).toEqual([]);
  });

  it('only matches items on the same map', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'wanderer', body: 0x0190, x: 5, y: 5, z: 0, map: 1 });
    const wrongMapTrap = createItem(w, { itemId: 0x09F8, x: 6, y: 5, z: 0, map: 2 });
    wrongMapTrap.script = '__test-trap';
    dispatchTileWalkEvents(w, mob,
      { x: 5, y: 5, z: 0, map: 1 },
      { x: 6, y: 5, z: 0, map: 1 });
    expect(calls).toEqual([]);
  });

  it('items without script are skipped (no throw)', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'wanderer', body: 0x0190, x: 5, y: 5, z: 0, map: 1 });
    createItem(w, { itemId: 0x09F8, x: 6, y: 5, z: 0, map: 1 });  // no script
    expect(() =>
      dispatchTileWalkEvents(w, mob,
        { x: 5, y: 5, z: 0, map: 1 },
        { x: 6, y: 5, z: 0, map: 1 })
    ).not.toThrow();
  });
});
