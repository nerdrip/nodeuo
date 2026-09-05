// PHASE DD / bugfix #72 — paragon kills must drop 1.5× gold + table
// amounts. Before the fix, paragon mobs dropped vanilla loot — the
// whole loot-multiplier hook in paragons.js was unwired.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { killMobile } from '../src/corpse.js';
import { paragonize } from '../src/systems/paragons.js';

describe('BUGFIX #72 — paragon dropLoot multiplier', () => {
  it('paragon corpse gold is 1.5× the mob.gold value', () => {
    const w = new World();
    const mob = w.createMobile({
      name: 'a wolf', body: 0xE1, x: 50, y: 50, z: 0, map: 1,
      hp: 200, hpMax: 200, str: 60,
    });
    mob.gold = 100;
    mob.kind = 'wolf';
    paragonize(mob);
    killMobile(w, mob, null);
    // Find the corpse spawned at the mob's death location.
    let corpse = null;
    for (const it of w.items.values()) {
      if (it.x === 50 && it.y === 50 && it.itemId === 0x2006) corpse = it;
    }
    expect(corpse).toBeTruthy();
    // Find the gold pile inside the corpse.
    let goldPile = null;
    for (const it of w.items.values()) {
      if (it.parent === corpse.serial && it.itemId === 0x0EED) goldPile = it;
    }
    expect(goldPile).toBeTruthy();
    expect(goldPile.amount).toBe(150); // 100 * 1.5
  });

  it('non-paragon corpse gold is unchanged (1.0×)', () => {
    const w = new World();
    const mob = w.createMobile({
      name: 'a rat', body: 0xEE, x: 60, y: 60, z: 0, map: 1,
      hp: 30, hpMax: 30,
    });
    mob.gold = 50;
    killMobile(w, mob, null);
    let corpse = null;
    for (const it of w.items.values()) {
      if (it.x === 60 && it.y === 60 && it.itemId === 0x2006) corpse = it;
    }
    let goldPile = null;
    for (const it of w.items.values()) {
      if (it.parent === corpse.serial && it.itemId === 0x0EED) goldPile = it;
    }
    expect(goldPile.amount).toBe(50);
  });

  it('inline lootTable amounts also scale 1.5× for paragon', () => {
    const w = new World();
    const mob = w.createMobile({
      name: 'a dragon', body: 0x0C, x: 70, y: 70, z: 0, map: 1,
      hp: 600, hpMax: 600,
    });
    mob.lootTable = [
      { itemId: 0x0F0A, amount: 4 },           // 4 gems
      { itemId: 0x0F7E, amount: [10, 10] },   // exactly 10 ingots
    ];
    paragonize(mob);
    killMobile(w, mob, null);
    let corpse = null;
    for (const it of w.items.values()) {
      if (it.x === 70 && it.y === 70 && it.itemId === 0x2006) corpse = it;
    }
    const drops = [];
    for (const it of w.items.values()) {
      if (it.parent === corpse.serial && it.itemId !== 0x0EED) drops.push(it);
    }
    // Both stacks should have been multiplied by 1.5 → 6 and 15.
    const gem = drops.find((d) => d.itemId === 0x0F0A);
    const ingot = drops.find((d) => d.itemId === 0x0F7E);
    expect(gem.amount).toBe(6);
    expect(ingot.amount).toBe(15);
  });
});
