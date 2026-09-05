// PHASE CT — auto-stack helpers + bugfix #62 regression: dropping a
// stackable item into a container that already contains a matching
// pile must merge the amount and destroy the incoming serial. Same
// for vendor purchases — buying 5 × gold should NOT spawn five
// separate piles in the buyer's pack.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import {
  createItem, findMergeableStack, mergeStacks, isStackableItemId,
  displayItemIdForAmount, splitStack,
} from '../src/world/items.js';

const GOLD = 0x0EED;
const BANDAGE = 0x0E21;
const SWORD = 0x0F61;     // longsword — NOT stackable

describe('item stacking helpers (PHASE CT)', () => {
  it('isStackableItemId recognises gold + reagents but not weapons', () => {
    expect(isStackableItemId(GOLD)).toBe(true);
    expect(isStackableItemId(0x0EEE)).toBe(true);
    expect(isStackableItemId(BANDAGE)).toBe(true);
    expect(isStackableItemId(SWORD)).toBe(false);
  });

  it('maps coin amount to ClassicUO display graphics', () => {
    expect(displayItemIdForAmount(0x0EED, 1)).toBe(0x0EED);
    expect(displayItemIdForAmount(0x0EED, 2)).toBe(0x0EEE);
    expect(displayItemIdForAmount(0x0EED, 5)).toBe(0x0EEE);
    expect(displayItemIdForAmount(0x0EED, 6)).toBe(0x0EEF);
    expect(displayItemIdForAmount(0x0EED, 500)).toBe(0x0EEF);
  });

  it('findMergeableStack matches same itemId + same hue in same container', () => {
    const w = new World();
    const pack = createItem(w, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1, gumpId: 0x3C,
    });
    const a = createItem(w, {
      itemId: GOLD, hue: 0, amount: 100, x: 0, y: 0, z: 0,
      parent: pack.serial,
    });
    const incoming = createItem(w, {
      itemId: GOLD, hue: 0, amount: 50, x: 0, y: 0, z: 0,
      parent: null,
    });
    const target = findMergeableStack(w, pack.serial, incoming);
    expect(target).toBe(a);
  });

  it('findMergeableStack rejects different hue', () => {
    const w = new World();
    const pack = createItem(w, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1, gumpId: 0x3C,
    });
    createItem(w, {
      itemId: 0x1BF2, hue: 0x96D, amount: 10, x: 0, y: 0, z: 0,
      parent: pack.serial,
    });
    const otherHue = createItem(w, {
      itemId: 0x1BF2, hue: 0x000, amount: 10, x: 0, y: 0, z: 0,
      parent: null,
    });
    expect(findMergeableStack(w, pack.serial, otherHue)).toBeNull();
  });

  it('findMergeableStack rejects non-stackable art ids', () => {
    const w = new World();
    const pack = createItem(w, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1, gumpId: 0x3C,
    });
    createItem(w, {
      itemId: SWORD, x: 0, y: 0, z: 0, parent: pack.serial,
    });
    const sword2 = createItem(w, {
      itemId: SWORD, x: 0, y: 0, z: 0, parent: null,
    });
    expect(findMergeableStack(w, pack.serial, sword2)).toBeNull();
  });

  it('mergeStacks adds amounts and destroys the incoming item', () => {
    const w = new World();
    const a = createItem(w, { itemId: GOLD, amount: 100, x: 0, y: 0, z: 0 });
    const b = createItem(w, { itemId: GOLD, amount: 50, x: 0, y: 0, z: 0 });
    const result = mergeStacks(w, a, b);
    expect(result).toBe(a);
    expect(a.amount).toBe(150);
    expect(w.items.has(b.serial)).toBe(false);
  });

  it('merges coin display variants as one canonical gold stack', () => {
    const w = new World();
    const pack = createItem(w, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1, gumpId: 0x3C,
    });
    const pile = createItem(w, {
      itemId: 0x0EEE, hue: 0, amount: 3, x: 0, y: 0, z: 0,
      parent: pack.serial,
    });
    const incoming = createItem(w, {
      itemId: GOLD, hue: 0, amount: 4, x: 0, y: 0, z: 0,
    });
    const target = findMergeableStack(w, pack.serial, incoming);
    expect(target).toBe(pile);
    mergeStacks(w, target, incoming);
    expect(pile.itemId).toBe(GOLD);
    expect(pile.amount).toBe(7);
    expect(displayItemIdForAmount(pile.itemId, pile.amount)).toBe(0x0EEF);
  });

  it('splitStack keeps the lifted serial and creates a remainder pile', () => {
    const w = new World();
    const pack = createItem(w, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1, gumpId: 0x3C,
    });
    const pile = createItem(w, {
      itemId: GOLD, hue: 0, amount: 100, x: 0, y: 0, z: 0,
      parent: pack.serial, gridX: 20, gridY: 30,
    });
    const remainder = splitStack(w, pile, 25);
    expect(pile.amount).toBe(25);
    expect(remainder.amount).toBe(75);
    expect(remainder.serial).not.toBe(pile.serial);
    expect(remainder.parent).toBe(pack.serial);
    expect(remainder.gridX).toBe(20);
    expect(remainder.gridY).toBe(30);
  });

  it('findMergeableStack ignores worn items (layer > 0)', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'mob', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    // A torch worn on layer 1 — should NOT count as a mergeable stack
    // even if the incoming item shares its art id.
    createItem(w, {
      itemId: GOLD, x: 0, y: 0, z: 0, parent: mob.serial, layer: 1, amount: 1,
    });
    const incoming = createItem(w, { itemId: GOLD, amount: 5, x: 0, y: 0, z: 0 });
    expect(findMergeableStack(w, mob.serial, incoming)).toBeNull();
  });
});
