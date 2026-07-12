import { afterEach, describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  setReagentTable,
  tryConsumeReagents,
} from '../src/systems/spells/reagents.js';

afterEach(() => setReagentTable({}));

describe('spell reagent consumption', () => {
  it('finds and consumes reagents inside the equipped backpack', () => {
    const world = new World();
    const caster = world.createMobile({ name: 'mage' });
    const backpack = createItem(world, {
      itemId: 0x0E75,
      parent: caster.serial,
      layer: 21,
      gumpId: 0x003C,
    });
    const reagent = createItem(world, {
      itemId: 0x0F7A,
      parent: backpack.serial,
      amount: 3,
    });
    setReagentTable({ 1: [0x0F7A] });

    expect(tryConsumeReagents(world, caster, 1)).toBe(true);
    expect(world.items.get(reagent.serial)?.amount).toBe(2);
  });

  it('checks duplicate costs atomically before consuming anything', () => {
    const world = new World();
    const caster = world.createMobile({ name: 'mystic' });
    const backpack = createItem(world, {
      itemId: 0x0E75,
      parent: caster.serial,
      layer: 21,
      gumpId: 0x003C,
    });
    const bone = createItem(world, {
      itemId: 0x0F7E,
      parent: backpack.serial,
      amount: 1,
    });
    setReagentTable({ 106: [0x0F7E, 0x0F7E] });

    expect(tryConsumeReagents(world, caster, 106)).toBe(false);
    expect(world.items.get(bone.serial)?.amount).toBe(1);
  });
});
