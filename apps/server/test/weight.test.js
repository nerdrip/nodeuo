import { describe, expect, it } from 'vitest';

import { encumbrance, maxWeight } from '../src/world/weight.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';

describe('maxWeight racial normalization', () => {
  it('treats legacy human race values as human', () => {
    expect(maxWeight({ str: 60, race: 'human' })).toBe(310);
    expect(maxWeight({ str: 60, race: 1 })).toBe(310);
    expect(maxWeight({ str: 60, race: 0 })).toBe(310);
    expect(maxWeight({ str: 60 })).toBe(310);
  });

  it('keeps non-human carrying capacity on string and numeric race values', () => {
    expect(maxWeight({ str: 60, race: 'elf' })).toBe(250);
    expect(maxWeight({ str: 60, race: 'gargoyle' })).toBe(250);
    expect(maxWeight({ str: 60, race: 2 })).toBe(250);
    expect(maxWeight({ str: 60, race: 3 })).toBe(250);
  });

  it('applies ServUO overload allowance, stamina cost and progressive NodeUO pace', () => {
    const world = new World();
    const mob = world.createMobile({ str: 10, stam: 50, x: 0, y: 0, z: 0, map: 1 });
    const pack = createItem(world, {
      itemId: 0x0E75, weight: 0, gumpId: 0x003C,
      parent: mob.serial, layer: 21, x: 0, y: 0, z: 0,
    });
    createItem(world, {
      itemId: 0x1000, weight: 130, parent: pack.serial,
      x: 0, y: 0, z: 0,
    });

    // capacity=135, total=body 14 + item 130 = 144, allowance=4 → 5 over.
    const walking = encumbrance(world, mob, false);
    expect(walking).toMatchObject({ weight: 144, capacity: 135, over: 5, overloaded: true });
    expect(walking.staminaCost).toBe(5);
    expect(walking.paceMultiplier).toBeGreaterThan(1);
    expect(encumbrance(world, mob, true).staminaCost).toBe(10);
  });
});
