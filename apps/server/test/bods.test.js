// FAZA BU — Bulk Order Deeds: generation, progress tracking, exceptional
// gating; plus bugfix #37 (craft() resolves the crafter's backpack from
// world.items instead of relying on a non-existent `mob.backpack`).

import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  makeRandomBOD, recordCraftForBods, formatBod,
  makeLargeBOD, bindSmallToLarge, isLargeBodComplete, rollBodReward,
  _LARGE_BOD_RECIPES,
} from '../src/systems/economy/bods.js';
import { craft, registerRecipe } from '../src/systems/crafting/index.js';

describe('BOD generation (FAZA BU)', () => {
  it('produces a deed with quantity in {10,15,20} and a target itemId', () => {
    const bod = makeRandomBOD(8); // smithy
    expect(bod).toBeTruthy();
    expect([10, 15, 20]).toContain(bod.quantity);
    expect(bod.progress).toBe(0);
    expect(typeof bod.itemId).toBe('number');
    expect(bod.itemId).toBeGreaterThan(0);
    expect(typeof bod.reward).toBe('string');
  });

  it('uses canonical skill ids for tailoring BODs', () => {
    const bod = makeRandomBOD(35); // Tailoring
    expect(bod).toBeTruthy();
    expect(bod.skill).toBe(35);
    expect(makeRandomBOD(22 /* Hiding, not Tailoring */)).toBeNull();
  });

  it('returns null for skills without a BOD catalogue', () => {
    expect(makeRandomBOD(99 /* nonsense */)).toBeNull();
  });

  it('formatBod produces a multi-line readable summary', () => {
    const bod = { skill: 8, itemId: 0x0F51, quantity: 10, progress: 3,
      exceptional: true, material: 'iron',
      reward: 'Small gold reward', label: '10 exceptional Dagger' };
    const text = formatBod(bod);
    expect(text).toContain('exceptional');
    expect(text).toContain('Progress: 3/10');
  });
});

describe('recordCraftForBods', () => {
  /** @type {World} */ let w;
  /** @type {any} */ let crafter;

  beforeEach(() => {
    w = new World();
    crafter = w.createMobile({ name: 'smith', body: 0x0190, x: 0, y: 0, z: 0, map: 1 });
  });

  function placeBod(opts) {
    const it = createItem(w, { itemId: 0x14EF, x: 0, y: 0, z: 0,
      parent: crafter.serial, layer: 0 });
    it.bod = { skill: 8, itemId: 0x0F51, quantity: 10, progress: 0,
      exceptional: false, material: 'iron', reward: '', label: '10 Dagger', ...opts };
    return it;
  }

  it('advances matching deeds in the crafter pack', () => {
    const it = placeBod({});
    const advanced = recordCraftForBods(w, crafter, { skillId: 8, outputItemId: 0x0F51 }, false);
    expect(advanced).toBe(1);
    expect(it.bod.progress).toBe(1);
  });

  it('skips deeds with a different skill or output item', () => {
    const wrongSkill = placeBod({ skill: 35 });
    const wrongItem  = placeBod({ itemId: 0xDEAD });
    recordCraftForBods(w, crafter, { skillId: 8, outputItemId: 0x0F51 }, false);
    expect(wrongSkill.bod.progress).toBe(0);
    expect(wrongItem.bod.progress).toBe(0);
  });

  it('exceptional-required deeds skip non-exceptional crafts', () => {
    const it = placeBod({ exceptional: true });
    recordCraftForBods(w, crafter, { skillId: 8, outputItemId: 0x0F51 }, false);
    expect(it.bod.progress).toBe(0);
    recordCraftForBods(w, crafter, { skillId: 8, outputItemId: 0x0F51 }, true);
    expect(it.bod.progress).toBe(1);
  });

  it('saturates at quantity (no overflow)', () => {
    const it = placeBod({ quantity: 2 });
    for (let i = 0; i < 5; i++) {
      recordCraftForBods(w, crafter, { skillId: 8, outputItemId: 0x0F51 }, false);
    }
    expect(it.bod.progress).toBe(2);
  });
});

describe('BUGFIX #73 — material gate on recordCraftForBods', () => {
  it('iron crafts do NOT advance a coloured-material BOD', () => {
    const w = new World();
    const crafter = w.createMobile({ name: 'smith', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const it = createItem(w, { itemId: 0x14EF, x: 0, y: 0, z: 0, parent: crafter.serial });
    it.bod = {
      skill: 8, itemId: 0x0F51, quantity: 10, progress: 0,
      exceptional: false, material: 'valorite', reward: '',
      label: '10 valorite Dagger',
    };
    recordCraftForBods(w, crafter, {
      skillId: 8, outputItemId: 0x0F51, material: 'iron',
    }, false);
    expect(it.bod.progress).toBe(0);
  });

  it('valorite crafts advance the valorite BOD', () => {
    const w = new World();
    const crafter = w.createMobile({ name: 'smith', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const it = createItem(w, { itemId: 0x14EF, x: 0, y: 0, z: 0, parent: crafter.serial });
    it.bod = {
      skill: 8, itemId: 0x0F51, quantity: 10, progress: 0,
      exceptional: false, material: 'valorite', reward: '',
      label: '10 valorite Dagger',
    };
    recordCraftForBods(w, crafter, {
      skillId: 8, outputItemId: 0x0F51, material: 'valorite',
    }, false);
    expect(it.bod.progress).toBe(1);
  });

  it('iron is the implicit material when not specified', () => {
    const w = new World();
    const crafter = w.createMobile({ name: 'smith', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const it = createItem(w, { itemId: 0x14EF, x: 0, y: 0, z: 0, parent: crafter.serial });
    it.bod = {
      skill: 8, itemId: 0x0F51, quantity: 10, progress: 0,
      exceptional: false, material: 'iron', reward: '', label: '10 Dagger',
    };
    // Recipe with no material → defaults to 'iron'.
    recordCraftForBods(w, crafter, { skillId: 8, outputItemId: 0x0F51 }, false);
    expect(it.bod.progress).toBe(1);
  });
});

describe('Large BODs (FAZA DE)', () => {
  it('makeLargeBOD builds the right slot list', () => {
    const lb = makeLargeBOD('plate-set');
    expect(lb).toBeTruthy();
    expect(lb.large).toBe(true);
    expect(lb.skill).toBe(8);
    expect(lb.slots.length).toBe(4);
    expect(lb.slots.every((s) => !s.done)).toBe(true);
  });

  it('returns null for unknown recipe', () => {
    expect(makeLargeBOD('does-not-exist')).toBeNull();
  });

  it('bindSmallToLarge requires matching skill / item / material / exceptional', () => {
    const lb = {
      large: true, skill: 8, material: 'iron', exceptional: false,
      slots: [
        { itemId: 0x140A, label: 'Helm', smallBodSerial: null, done: false },
      ],
      reward: 'rh', label: 'Plate Set',
    };
    // Wrong skill
    expect(bindSmallToLarge(lb, { serial: 1, bod: { skill: 22, itemId: 0x140A, progress: 10, quantity: 10, material: 'iron', exceptional: false } }).ok).toBe(false);
    // Wrong material
    expect(bindSmallToLarge(lb, { serial: 1, bod: { skill: 8, itemId: 0x140A, progress: 10, quantity: 10, material: 'valorite', exceptional: false } }).ok).toBe(false);
    // Incomplete small
    expect(bindSmallToLarge(lb, { serial: 1, bod: { skill: 8, itemId: 0x140A, progress: 5, quantity: 10, material: 'iron', exceptional: false } }).ok).toBe(false);
    // Exceptional mismatch
    expect(bindSmallToLarge(lb, { serial: 1, bod: { skill: 8, itemId: 0x140A, progress: 10, quantity: 10, material: 'iron', exceptional: true } }).ok).toBe(false);
    // No matching slot for itemId
    expect(bindSmallToLarge(lb, { serial: 1, bod: { skill: 8, itemId: 0xDEAD, progress: 10, quantity: 10, material: 'iron', exceptional: false } }).ok).toBe(false);
    // Happy path
    const r = bindSmallToLarge(lb, { serial: 42, bod: { skill: 8, itemId: 0x140A, progress: 10, quantity: 10, material: 'iron', exceptional: false } });
    expect(r.ok).toBe(true);
    expect(lb.slots[0].done).toBe(true);
    expect(lb.slots[0].smallBodSerial).toBe(42);
  });

  it('isLargeBodComplete = all slots done', () => {
    const lb = {
      large: true, skill: 8,
      slots: [{ done: false }, { done: true }],
    };
    expect(isLargeBodComplete(lb)).toBe(false);
    lb.slots[0].done = true;
    expect(isLargeBodComplete(lb)).toBe(true);
  });

  it('exposes the canonical recipe set', () => {
    expect(_LARGE_BOD_RECIPES['plate-set']).toBeTruthy();
    expect(_LARGE_BOD_RECIPES['weapons-set']).toBeTruthy();
    expect(_LARGE_BOD_RECIPES['wardrobe']).toBeTruthy();
    expect(_LARGE_BOD_RECIPES['wardrobe'].skill).toBe(35);
    expect(_LARGE_BOD_RECIPES['bow-set'].skill).toBe(9);
    expect(_LARGE_BOD_RECIPES['scroll-set'].skill).toBe(24);
  });
});

describe('BOD reward catalog skill ids', () => {
  it('uses canonical reward catalog keys', () => {
    expect(rollBodReward({ skill: 35, quantity: 10, exceptional: false, material: 'iron' })[0].name)
      .toBe('cloth bolts');
    expect(rollBodReward({ skill: 9, quantity: 10, exceptional: false, material: 'iron' })[0].name)
      .toBe('boards');
    expect(rollBodReward({ skill: 24, quantity: 10, exceptional: false, material: 'iron' })[0].name)
      .toBe('blank scrolls');
  });
});

describe('BUGFIX #37 — craft() resolves backpack from world.items', () => {
  it('uses the layer-21 worn container instead of mob.backpack', () => {
    const w = new World();
    const crafter = w.createMobile({ name: 'smith', body: 0x0190, x: 0, y: 0, z: 0, map: 1 });
    crafter.skills = { 8: 100 };
    const pack = createItem(w, { itemId: 0x0E75, x: 0, y: 0, z: 0,
      parent: crafter.serial, layer: 21 });

    registerRecipe({
      id: 99001, name: 'Test', category: 'Test', skillId: 8,
      minSkill: 0, maxSkill: 100,
      outputItemId: 0xCAFE, outputCount: 1,
      inputs: [], exceptionalChance: 0,
    });

    let resolvedContainer = undefined;
    const itemStore = {
      consumeIngredients: () => true,
      spawnItem: (opts) => { resolvedContainer = opts.container; return { serial: 1 }; },
    };

    // Hammer pSuccess to 1 by re-rolling many times (skill=100 vs minSkill=0
    // → pSuccess = 100/100 = 1.0 already, so one call suffices).
    craft({ recipeId: 99001, crafter, world: w, itemStore });
    expect(resolvedContainer).toBe(pack.serial);
  });
});
