import { describe, expect, it } from 'vitest';
import {
  buildEquipmentByOwner,
  equipmentFor,
} from '../src/net/handlers/equipment-visibility.js';

const worn = (serial, parent, layer, hue = 0) => ({
  serial, parent, layer, hue, itemId: 0x1000 + serial,
});

describe('equipment visibility indexing', () => {
  it('uses the reverse parent index and excludes container contents', () => {
    const shirt = worn(1, 100, 5, 33);
    const backpackContent = worn(2, 100, 0);
    const world = {
      items: new Map([[1, shirt], [2, backpackContent]]),
      _childrenByParent: new Map([[100, new Set([1, 2])]]),
    };

    const byOwner = buildEquipmentByOwner(world);
    expect(byOwner.get(100)).toEqual([shirt]);
    expect(equipmentFor(world, { serial: 100 }, byOwner)).toEqual([{
      serial: 1, itemId: 0x1001, layer: 5, hue: 33,
    }]);
  });

  it('supports legacy worlds populated without a reverse index', () => {
    const hat = worn(3, 200, 6);
    const other = worn(4, 201, 7);
    const world = { items: new Map([[3, hat], [4, other]]) };

    expect(equipmentFor(world, { serial: 200 })).toEqual([{
      serial: 3, itemId: 0x1003, layer: 6, hue: 0,
    }]);
    expect(buildEquipmentByOwner(world).get(201)).toEqual([other]);
  });

  it('publishes one stable item per layer when a legacy save has duplicates', () => {
    const originalBank = worn(5, 300, 29);
    const duplicateBank = worn(6, 300, 29, 50);
    const shirt = worn(7, 300, 5, 33);
    const world = {
      items: new Map([[5, originalBank], [6, duplicateBank], [7, shirt]]),
      _childrenByParent: new Map([[300, new Set([5, 6, 7])]]),
    };

    expect(equipmentFor(world, { serial: 300 })).toEqual([
      { serial: 5, itemId: 0x1005, layer: 29, hue: 0 },
      { serial: 7, itemId: 0x1007, layer: 5, hue: 33 },
    ]);
  });
});
