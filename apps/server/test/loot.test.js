import { describe, it, expect, beforeEach } from 'vitest';
import { LootRegistry } from '../src/world/loot.js';
import { registerTemplate, _resetTemplatesForTest } from '../src/world/templates.js';
import { World } from '../src/world/world.js';
import { createItem, containerChildren } from '../src/world/items.js';

describe('LootRegistry', () => {
  beforeEach(() => {
    _resetTemplatesForTest();
    registerTemplate({ name: 'gold',   itemId: 0x0EED, label: 'gold coins' });
    registerTemplate({ name: 'shield', itemId: 0x1B72, label: 'a wooden shield' });
    registerTemplate({ name: 'ribs',   itemId: 0x097B, label: 'raw ribs' });
  });

  function makeCorpse(world) {
    return createItem(world, { itemId: 0x2006, x: 0, y: 0, z: 0, map: 1 });
  }

  it('drops deterministic entries when chance is omitted or 1', () => {
    const world = new World();
    const reg = new LootRegistry();
    reg.register({
      name: 'orc',
      entries: [
        { template: 'gold',   amount: [10, 10] },
        { template: 'shield' },
      ],
    });
    const corpse = makeCorpse(world);
    reg.roll(world, corpse, 'orc', () => 0.0);
    const children = [...containerChildren(world, corpse.serial)];
    expect(children.length).toBe(2);
    const gold = children.find((c) => c.itemId === 0x0EED);
    expect(gold.amount).toBe(10);
    const shield = children.find((c) => c.itemId === 0x1B72);
    expect(shield).toBeDefined();
  });

  it('honors chance by skipping entries when rng >= chance', () => {
    const world = new World();
    const reg = new LootRegistry();
    reg.register({
      name: 'flaky',
      entries: [
        { template: 'shield', chance: 0.5 },
        { template: 'ribs',   chance: 0.5 },
      ],
    });
    const corpse = makeCorpse(world);
    reg.roll(world, corpse, 'flaky', () => 0.9);
    expect([...containerChildren(world, corpse.serial)].length).toBe(0);
    reg.roll(world, corpse, 'flaky', () => 0.1);
    expect([...containerChildren(world, corpse.serial)].length).toBe(2);
  });

  it('composes nested tables via table references', () => {
    const world = new World();
    const reg = new LootRegistry();
    reg.register({ name: 'base', entries: [{ template: 'gold', amount: 5 }] });
    reg.register({ name: 'top',  entries: [{ table: 'base' }, { template: 'shield' }] });
    const corpse = makeCorpse(world);
    reg.roll(world, corpse, 'top', () => 0);
    const children = [...containerChildren(world, corpse.serial)];
    expect(children.length).toBe(2);
  });

  it('falls back to itemId when no template is known', () => {
    const world = new World();
    const reg = new LootRegistry();
    reg.register({ name: 'raw', entries: [{ itemId: 0x1234, amount: 3 }] });
    const corpse = makeCorpse(world);
    reg.roll(world, corpse, 'raw', () => 0);
    const items = [...containerChildren(world, corpse.serial)];
    expect(items[0].itemId).toBe(0x1234);
    expect(items[0].amount).toBe(3);
  });

  it('guards against infinite recursion', () => {
    const reg = new LootRegistry();
    reg.register({ name: 'a', entries: [{ table: 'b' }] });
    reg.register({ name: 'b', entries: [{ table: 'a' }] });
    const world = new World();
    const corpse = makeCorpse(world);
    expect(() => reg.roll(world, corpse, 'a', () => 0)).toThrow(/recursion/);
  });
});
