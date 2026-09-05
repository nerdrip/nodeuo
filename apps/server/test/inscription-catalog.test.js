import { describe, expect, it, vi } from 'vitest';

import registerInscription from '../../scripts/src/crafting/inscription.js';
import registerScrolls from '../../scripts/src/items/definitions/scrolls.js';
import { validateRecipeAccess } from '../../scripts/src/commands/crafting/craft.js';
import { World } from '../src/world/world.js';

function inscriptionRecipes() {
  const rows = [];
  registerInscription({
    systems: { crafting: { registerRecipe: (recipe) => rows.push(recipe) } },
  });
  return rows;
}

describe('complete Inscription catalog', () => {
  it('registers all canonical scroll recipes with stable unique ids and art', () => {
    const rows = inscriptionRecipes();
    expect(rows).toHaveLength(97);
    expect(new Set(rows.map((row) => row.id)).size).toBe(97);
    expect(rows.filter((row) => row.category.startsWith('Circle '))).toHaveLength(64);
    expect(rows.filter((row) => row.category === 'Necromancy')).toHaveLength(17);
    expect(rows.filter((row) => row.category === 'Mysticism')).toHaveLength(16);

    expect(rows.find((row) => row.id === 22_001)).toMatchObject({
      name: 'Clumsy Scroll', outputItemId: 0x1F2D, minSkill: -250,
      manaCost: 4, requiresSpell: 1,
    });
    expect(rows.find((row) => row.id === 22_064)).toMatchObject({
      name: 'Summon Water Elemental Scroll', outputItemId: 0x1F6C, requiresSpell: 64,
    });
    expect(rows.find((row) => row.id === 22_101)).toMatchObject({
      name: 'Animate Dead Scroll', outputItemId: 0x2260, requiresSpell: 101,
    });
    expect(rows.find((row) => row.id === 22_117)).toMatchObject({
      name: 'Exorcism Scroll', outputItemId: 0x2270, requiresSpell: 117,
    });
    expect(rows.find((row) => row.id === 22_200)).toMatchObject({
      name: 'Nether Bolt Scroll', outputItemId: 0x2D9E, requiresSpell: 677,
    });
    expect(rows.find((row) => row.id === 22_215)).toMatchObject({
      name: 'Rising Colossus Scroll', outputItemId: 0x2DAD, requiresSpell: 692,
    });
    const plague = rows.find((row) => row.name === 'Spell Plague Scroll');
    expect(plague.inputs).toContainEqual({ itemId: 0x0F80, count: 2 });
  });

  it('registers 97 usable scroll items plus the blank scroll on a cold load', () => {
    const items = [];
    registerScrolls({
      systems: {
        spells: {
          allSpells: () => [],
          getSpell: vi.fn(),
          castSpell: vi.fn(),
        },
      },
      catalog: { items: { registerItem: (item) => items.push(item) } },
    });
    expect(items).toHaveLength(98);
    expect(items.find((item) => item.spellId === 1)).toMatchObject({ id: 0x1F2D });
    expect(items.find((item) => item.spellId === 64)).toMatchObject({ id: 0x1F6C });
    expect(items.find((item) => item.spellId === 101)).toMatchObject({ id: 0x2260 });
    expect(items.find((item) => item.spellId === 677)).toMatchObject({ id: 0x2D9E });
    expect(items.find((item) => item.spellId === 692)).toMatchObject({ id: 0x2DAD });
    expect(items.find((item) => item.id === 0x0E34)).toMatchObject({ category: 'blank-scroll' });
  });

  it('requires the authored spell in a compatible carried spellbook', () => {
    const world = new World();
    const crafter = world.createMobile({ name: 'Scribe' });
    const pack = world.createItem({ itemId: 0x0E75, parent: crafter.serial, layer: 21 });
    const mageryBook = world.createItem({ itemId: 0x0EFA, parent: pack.serial, spellbook: true });
    const mysticBook = world.createItem({ itemId: 0x2D9D, parent: pack.serial, spellbook: true });
    const knows = vi.fn((serial, spellId) =>
      (serial === mageryBook.serial && spellId === 1)
      || (serial === mysticBook.serial && spellId === 678));
    const api = { world, spellbooks: { knows } };

    expect(validateRecipeAccess(api, crafter, { requiresSpell: 1, category: 'Circle 1' })).toBe(true);
    expect(validateRecipeAccess(api, crafter, { requiresSpell: 2, category: 'Circle 1' })).toBe('spell-not-known');
    expect(validateRecipeAccess(api, crafter, { requiresSpell: 677, category: 'Mysticism' })).toBe(true);
    expect(knows).toHaveBeenCalledWith(mysticBook.serial, 678);
  });
});
