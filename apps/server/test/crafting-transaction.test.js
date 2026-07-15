import { describe, expect, it, vi } from 'vitest';
import { buildItemStore, findCraftingTool } from '../../scripts/src/commands/crafting/craft.js';
import { craft, recipeCatalogDiagnostics, registerRecipe } from '../src/systems/crafting/index.js';
import { findRunicTool } from '../src/systems/crafting/runic.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { mobileTotalWeight } from '../src/world/weight.js';

function inventory() {
  const world = new World();
  const crafter = world.createMobile({ name: 'smith', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
  crafter.skills = { 8: 100 };
  const pack = createItem(world, { itemId: 0x0E75, parent: crafter.serial, layer: 21 });
  const api = {
    world,
    items: {
      createItem: (w, data) => createItem(w, data),
      destroyItem: (w, serial) => w.destroyItem(serial),
    },
  };
  return { world, crafter, pack, api };
}

describe('crafting transactions', () => {
  it('does not consume an earlier ingredient when a later one is missing', () => {
    const f = inventory();
    const ingots = createItem(f.world, { itemId: 0x1BF2, amount: 3, parent: f.pack.serial });
    const store = buildItemStore(f.api);
    expect(store.consumeIngredients(f.crafter, [
      { itemId: 0x1BF2, count: 2 },
      { itemId: 0x0F7A, count: 1 },
    ], 1)).toBe(false);
    expect(f.world.items.get(ingots.serial)?.amount).toBe(3);
  });

  it('finds regular and runic tools nested in the backpack', () => {
    const f = inventory();
    const hammer = createItem(f.world, { itemId: 0x13E3, parent: f.pack.serial, tool: { charges: 5 } });
    const runic = createItem(f.world, { itemId: 0x13E3, parent: f.pack.serial });
    runic.runicTool = { kind: 'smith', resource: 'valorite', charges: 2 };
    expect(findCraftingTool(f.api, f.crafter, 'smith')).toBe(hammer);
    expect(findRunicTool(f.world, f.crafter, 'smith')).toMatchObject({ tool: runic, tier: 'valorite' });
  });

  it('does not commit reserved resources when output allocation fails', () => {
    const id = 99120;
    registerRecipe({
      id, name: 'Transactional test', category: 'Tests', skillId: 8,
      minSkill: 0, maxSkill: 100, outputItemId: 0x0F51, outputCount: 1,
      inputs: [{ itemId: 0x1BF2, count: 1 }], exceptionalChance: 0,
    });
    const commit = vi.fn(() => true);
    const result = craft({
      recipeId: id,
      crafter: { serial: 1, name: 'smith', skills: { 8: 100 } },
      world: { items: new Map() },
      itemStore: {
        checkIngredients: () => true,
        reserveIngredients: () => ({ commit }),
        spawnItem: () => null,
      },
    });
    expect(result).toMatchObject({ ok: false, reason: 'output-failed' });
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps authoritative carried weight unchanged after a craft rollback', () => {
    const f = inventory();
    createItem(f.world, { itemId: 0x1BF2, amount: 2, weight: 1, parent: f.pack.serial });
    const id = 99121;
    registerRecipe({
      id, name: 'Weight rollback test', category: 'Tests', skillId: 8,
      minSkill: 0, maxSkill: 100, outputItemId: 0x0F51, outputCount: 1,
      inputs: [{ itemId: 0x1BF2, count: 1 }], exceptionalChance: 0,
    });
    const actualStore = buildItemStore(f.api);
    const weightBeforeRollback = mobileTotalWeight(f.world, f.crafter);
    const result = craft({ recipeId: id, crafter: f.crafter, world: f.world,
      itemStore: { ...actualStore, spawnItem: () => null } });
    expect(result).toMatchObject({ ok: false, reason: 'output-failed' });
    expect(mobileTotalWeight(f.world, f.crafter)).toBe(weightBeforeRollback);
  });

  it('maintains an indexed, startup-auditable recipe catalog', () => {
    expect(recipeCatalogDiagnostics()).toMatchObject({
      ok: true,
      recipes: expect.any(Number),
      skills: expect.any(Number),
      categories: expect.any(Number),
    });
  });
});
