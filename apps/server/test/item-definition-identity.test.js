import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  getItem, getItemByDefinition, getItemByTag, itemVariants, registerItem, unregisterItem,
} from '../src/content/items/index.js';
import { useItem } from '../src/world/templates.js';

describe('canonical item definition identity', () => {
  it('keeps gameplay identity separate from shared artwork', () => {
    const artId = 0x7A10;
    const calls = [];
    registerItem({
      definitionId: '__test-ticket-red', artId,
      name: 'Red test ticket', hue: 33,
      effect: () => calls.push('red'),
    });
    registerItem({
      definitionId: '__test-ticket-blue', artId,
      name: 'Blue test ticket', hue: 88,
      effect: () => calls.push('blue'),
    });

    const redDef = getItemByDefinition('__test-ticket-red');
    const blueDef = getItem('__test-ticket-blue');
    expect(redDef).toMatchObject({
      id: '__test-ticket-red', definitionId: '__test-ticket-red',
      artId, itemId: artId, name: 'Red test ticket', hue: 33,
    });
    expect(blueDef).toMatchObject({ definitionId: '__test-ticket-blue', artId, hue: 88 });
    expect(itemVariants(artId).map((row) => row.definitionId)).toEqual([
      '__test-ticket-red', '__test-ticket-blue',
    ]);

    const world = new World();
    const red = createItem(world, {
      definitionId: '__test-ticket-red', x: 1, y: 1, z: 0,
    });
    const blue = createItem(world, {
      definitionId: '__test-ticket-blue', x: 1, y: 1, z: 0,
    });
    expect(red).toMatchObject({
      definitionId: '__test-ticket-red', artId, itemId: artId,
      name: 'Red test ticket', hue: 33,
    });
    expect(blue).toMatchObject({
      definitionId: '__test-ticket-blue', artId, itemId: artId,
      name: 'Blue test ticket', hue: 88,
    });

    expect(useItem(world, red, {})).toBe(true);
    expect(useItem(world, blue, {})).toBe(true);
    expect(calls).toEqual(['red', 'blue']);
  });

  it('keeps ground art independent from explicit paperdoll gump art', () => {
    const world = new World();
    registerItem({
      definitionId: '__test-book-armour', artId: 0x0ff1, hue: 1150,
      name: 'Book armour artifact', script: null, equipLayer: 22,
      paperdollGumpId: 0xc351,
      paperdollMaleGumpId: 0xc352,
      paperdollFemaleGumpId: 0xea62,
    });
    const item = createItem(world, { definitionId: '__test-book-armour', x: 1, y: 1, z: 0 });
    expect(item).toMatchObject({
      definitionId: '__test-book-armour', artId: 0x0ff1, itemId: 0x0ff1, hue: 1150,
      paperdollGumpId: 0xc351, paperdollMaleGumpId: 0xc352, paperdollFemaleGumpId: 0xea62,
    });
  });

  it('normalises legacy numeric id + tagId definitions', () => {
    const def = registerItem({
      id: 0x7A11, tagId: '__test-legacy-ticket',
      name: 'Legacy ticket', hue: 7,
    });
    expect(def).toMatchObject({
      id: '__test-legacy-ticket', definitionId: '__test-legacy-ticket',
      artId: 0x7A11, itemId: 0x7A11, script: null,
    });
    expect(getItem('__test-legacy-ticket')?.definitionId).toBe('__test-legacy-ticket');
    expect(getItem(0x7A11)).toBeUndefined();
  });

  it('removes aliases safely and cannot dispose a newer hot-reload generation', () => {
    const first = registerItem({
      definitionId: '__test-hot-item', tagId: '__test-hot-old',
      artId: 0x7A12, name: 'First generation',
    });
    const second = registerItem({
      definitionId: '__test-hot-item', tagId: '__test-hot-new',
      artId: 0x7A13, name: 'Second generation',
    });

    expect(getItemByTag('__test-hot-old')).toBeUndefined();
    expect(unregisterItem(first.definitionId, first)).toBe(false);
    expect(getItemByDefinition(first.definitionId)).toBe(second);
    expect(unregisterItem(second.definitionId, second)).toBe(true);
    expect(getItemByDefinition(second.definitionId)).toBeUndefined();
    expect(getItemByTag('__test-hot-new')).toBeUndefined();
    expect(itemVariants(0x7A13)).toEqual([]);
  });
});
