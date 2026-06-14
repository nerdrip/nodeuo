// BUGFIX #32 (FAZA BP): killMobile must fire `onUnequip` on every worn
// item before re-parenting it to the corpse. Otherwise lifecycle
// scripts that maintain "while worn" state (lit torches, equip-driven
// auras, durability tickers) silently leak across the death boundary.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { killMobile } from '../src/corpse.js';
import { registerItemScript, unregisterItemScript } from '../src/world/item-scripts.js';

describe('killMobile fires onUnequip for worn items (FAZA BP)', () => {
  /** @type {{ serial:number, item:any, mob:any }[]} */
  let calls;

  beforeEach(() => {
    calls = [];
    registerItemScript({
      name: '__test-corpse-unequip',
      onUnequip(_w, item, mob) {
        calls.push({ serial: item.serial, item, mob });
      },
    });
  });
  afterEach(() => {
    unregisterItemScript('__test-corpse-unequip');
  });

  it('dispatches onUnequip for each worn item before clearing the layer', () => {
    // User-reported bug fix: player corpses now KEEP the backpack
    // (layer 21), Hair (11), Beard (16), Mount (25), Bank (29) on the
    // ghost. Equipment in other layers drops as before. Resurrected
    // players can re-equip without a vendor-bought pack.
    const w = new World();
    const mob = w.createMobile({ name: 'doomed', body: 0x0190, x: 10, y: 10, z: 0, map: 1 });
    mob.hpMax = 50; mob.hp = 50;
    mob.client = { send: () => {}, sendSystemMessage: () => {} };

    // Equipped torch (worn, layer 1).
    const torch = createItem(w, {
      itemId: 0x0A12, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      parent: mob.serial, layer: 1,
    });
    torch.script = '__test-corpse-unequip';

    // Backpack (layer 21) — for player corpses this stays on the body.
    const pack = createItem(w, {
      itemId: 0x0E75, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      parent: mob.serial, layer: 21,
    });
    pack.script = '__test-corpse-unequip';

    killMobile(w, mob);

    // Torch dropped to corpse; backpack stayed on ghost.
    expect(calls.map((c) => c.serial)).toContain(torch.serial);
    expect(torch.layer).toBe(0);
    expect(torch.parent).not.toBe(mob.serial);
    // Backpack persists on the player (was on mob.serial, still is).
    expect(pack.layer).toBe(21);
    expect(pack.parent).toBe(mob.serial);
  });

  it('does NOT fire onUnequip for unworn items in the mobile inventory', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'doomed', body: 0x0190, x: 10, y: 10, z: 0, map: 1 });
    mob.hpMax = 50; mob.hp = 50;
    mob.client = { send: () => {}, sendSystemMessage: () => {} };

    // Item directly parented to the mob but layer=0 (e.g. carried in hand
    // pre-equip) — should NOT fire onUnequip; only worn items do.
    const stray = createItem(w, {
      itemId: 0x0A12, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      parent: mob.serial, layer: 0,
    });
    stray.script = '__test-corpse-unequip';

    killMobile(w, mob);
    expect(calls.length).toBe(0);
  });
});
