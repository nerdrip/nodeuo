import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import alchemy from '../../scripts/src/crafting/alchemy.js';
import blacksmithing from '../../scripts/src/crafting/blacksmithing.js';
import carpentry from '../../scripts/src/crafting/carpentry.js';
import cartography from '../../scripts/src/crafting/cartography.js';
import cooking from '../../scripts/src/crafting/cooking.js';
import fletching from '../../scripts/src/crafting/fletching.js';
import glassblowing from '../../scripts/src/crafting/glassblowing.js';
import inscription from '../../scripts/src/crafting/inscription.js';
import masonry from '../../scripts/src/crafting/masonry.js';
import tailoring from '../../scripts/src/crafting/tailoring.js';
import tinkering from '../../scripts/src/crafting/tinkering.js';
import buildRecipeManual from '../../scripts/src/items/scripts/consumables/imbue-recipe-scroll.js';

const REGISTRARS = [
  alchemy, blacksmithing, carpentry, cartography, cooking, fletching,
  glassblowing, inscription, masonry, tailoring, tinkering,
];

function allRecipes() {
  const rows = [];
  for (const register of REGISTRARS) {
    register({ systems: { crafting: { registerRecipe: (recipe) => rows.push(recipe) } } });
  }
  return rows;
}

describe('complete crafting catalog audit', () => {
  it('keeps every recipe structurally executable and globally addressable', () => {
    const rows = allRecipes();
    expect(rows).toHaveLength(411);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.skillId, row.name).toBeGreaterThanOrEqual(1);
      expect(row.skillId, row.name).toBeLessThanOrEqual(58);
      expect(Number.isFinite(row.minSkill), row.name).toBe(true);
      expect(Number.isFinite(row.maxSkill), row.name).toBe(true);
      expect(row.maxSkill, row.name).toBeGreaterThanOrEqual(row.minSkill);
      expect(row.outputItemId, row.name).toBeGreaterThan(0);
      expect(row.outputItemId, row.name).toBeLessThanOrEqual(0xFFFF);
      expect(row.outputCount, row.name).toBeGreaterThan(0);
      expect(row.toolKind, row.name).toEqual(expect.any(String));
      expect(Array.isArray(row.inputs), row.name).toBe(true);
    }
  });

  it('models Masonry and Glassblowing as learned branches of real UO skills', () => {
    const rows = allRecipes();
    const masonryRows = rows.filter((row) => row.toolKind === 'mason');
    const glassRows = rows.filter((row) => row.toolKind === 'glassblowing');
    expect(masonryRows).toHaveLength(12);
    expect(masonryRows.every((row) => row.skillId === 12 && row.requiresRecipe === 'masonry')).toBe(true);
    expect(glassRows).toHaveLength(8);
    expect(glassRows.every((row) => row.skillId === 1 && row.requiresRecipe === 'glassblowing')).toBe(true);
  });

  it('makes the vendor-sold knowledge books functional consumables', () => {
    const definitions = JSON.parse(fs.readFileSync(
      new URL('../../scripts/src/data/config/item-types.json', import.meta.url), 'utf8'));
    expect(definitions.GlassblowingBook).toMatchObject({
      script: 'imbue-recipe-scroll', recipeUnlock: 'glassblowing',
    });
    expect(definitions.MasonryBook).toMatchObject({
      script: 'imbue-recipe-scroll', recipeUnlock: 'masonry',
    });
  });

  it('requires the canonical grandmaster skill before consuming specialist manuals', () => {
    const messages = [];
    const account = {};
    const user = {
      serial: 1, skills: { 1: 99 },
      client: { account, send() {}, sendSystemMessage: (message) => messages.push(message) },
    };
    const item = {
      serial: 2, parent: 3, amount: 2, recipeUnlock: 'glassblowing',
      name: 'Glassblowing Book',
    };
    const world = { items: new Map([[item.serial, item]]) };
    const api = {
      game: { inventory: { isInPack: () => true } },
      protocol: { containerContentUpdate: () => new Uint8Array() },
    };
    const script = buildRecipeManual(api);

    script.onUse(world, item, user);
    expect(account.recipes).toBeUndefined();
    expect(item.amount).toBe(2);
    expect(messages.at(-1)).toMatch(/Grandmaster Alchemy/);

    user.skills[1] = 100;
    script.onUse(world, item, user);
    expect(account.recipes).toEqual(new Set(['glassblowing']));
    expect(item.amount).toBe(1);
  });
});
