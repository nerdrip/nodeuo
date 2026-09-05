import { afterEach, describe, expect, it, vi } from 'vitest';
import registerCraft from '../../scripts/src/commands/crafting/craft.js';

function fixture() {
  const commands = new Map();
  const sender = { serial: 0x1234, skills: { 8: 100 } };
  const recipe = {
    id: 7001, name: 'Dagger', category: 'Weapons', skillId: 8,
    minSkill: 200, maxSkill: 1000, outputItemId: 0x0F51, outputCount: 1,
    toolKind: 'smith', inputs: [{ itemId: 0x1BF2, count: 3 }], exceptionalChance: 0.1,
  };
  const crafting = {
    CRAFT_DELAY_MS: { smith: 10 },
    emitCraftSfx: vi.fn(),
    allRecipes: () => [recipe],
    recipesForSkill: () => [recipe],
    getRecipe: (id) => Number(id) === recipe.id ? recipe : null,
    craft: vi.fn(() => ({ ok: true, exceptional: false, resource: 'iron' })),
  };
  const world = { mobiles: new Map([[sender.serial, sender]]), items: new Map() };
  const messages = [];
  const state = {
    supportsNodeUO: (capability) => capability === 'crafting.workbench',
    sendSystemMessage: (message) => messages.push(message),
    account: {},
  };
  const api = {
    world,
    systems: { crafting },
    nodeUO: { features: { CraftingWorkbench: 'crafting.workbench' } },
    commands: {
      register: (definition) => commands.set(definition.name, definition),
      unregister: (name) => commands.delete(name),
    },
  };
  registerCraft(api);
  return { api, commands, sender, recipe, crafting, world, state, messages };
}

afterEach(() => { vi.useRealTimers(); });

describe('negotiated crafting workbench', () => {
  it('publishes human skill ranges, preview metadata and material palette', () => {
    const f = fixture();
    f.commands.get('craft').run({ sender: f.sender, state: f.state, world: f.world, args: ['gump', 'smithing'] });
    const payload = f.messages.find((message) => message.startsWith('@@OPEN_CRAFT_GUMP@@'));
    expect(payload).toContain('|20.0|100.0|');
    expect(payload).toContain('Weapons');
    expect(payload).toContain('dull-copper');
  });

  it('validates material names and processes a bounded cancellable batch sequentially', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const command = f.commands.get('craft');
    const ctx = { sender: f.sender, state: f.state, world: f.world };
    command.run({ ...ctx, args: ['material', 'valorite'] });
    expect(f.sender._craftMaterial).toMatchObject({ name: 'valorite', hue: 0x8AB });
    command.run({ ...ctx, args: ['batch', '7001', '2'] });
    await vi.runAllTimersAsync();
    expect(f.crafting.craft).toHaveBeenCalledTimes(2);
    expect(f.crafting.craft.mock.calls[0][0].material).toMatchObject({ name: 'valorite' });
    expect(f.messages.some((message) => message.includes('@@CRAFT_PROGRESS@@7001|2|2|complete'))).toBe(true);
    expect(f.sender._craftQueue).toBeNull();
  });

  it('does not commit a delayed craft after the connection closes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const command = f.commands.get('craft');
    command.run({ sender: f.sender, state: f.state, world: f.world, args: ['7001'] });
    f.state._closed = true;
    await vi.runAllTimersAsync();
    expect(f.crafting.craft).not.toHaveBeenCalled();
  });

  it('keeps bounded server-side favorites for negotiated clients', () => {
    const f = fixture();
    const command = f.commands.get('craft');
    command.run({ sender: f.sender, state: f.state, world: f.world, args: ['favorite', '7001'] });
    expect(f.state.account.craftFavorites.has(7001)).toBe(true);
    command.run({ sender: f.sender, state: f.state, world: f.world, args: ['favorite', '7001'] });
    expect(f.state.account.craftFavorites.has(7001)).toBe(false);
  });

  it('filters learned specialist branches instead of mixing their base skill catalog', () => {
    const f = fixture();
    const carpenter = { ...f.recipe, id: 7002, name: 'Chair', skillId: 12, toolKind: 'carpenter' };
    const masonry = { ...f.recipe, id: 31_001, name: 'Stone Block', skillId: 12, toolKind: 'mason' };
    f.crafting.allRecipes = () => [carpenter, masonry];
    f.crafting.recipesForSkill = () => [carpenter, masonry];

    f.commands.get('craft').run({
      sender: f.sender, state: f.state, world: f.world, args: ['gump', 'masonry'],
    });
    const payload = f.messages.find((message) => message.startsWith('@@OPEN_CRAFT_GUMP@@'));
    expect(payload).toContain('Stone Block');
    expect(payload).not.toContain('Chair');
  });
});
