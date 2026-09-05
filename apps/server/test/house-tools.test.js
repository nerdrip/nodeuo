import { describe, expect, it } from 'vitest';
import { HouseRegistry } from '../src/systems/housing/houses.js';

function setup() {
  const houses = new HouseRegistry();
  const owner = { serial: 0x1001, name: 'Builder' };
  const house = houses.place(owner, {
    x1: 100, y1: 100, x2: 110, y2: 110, map: 1, foundation: 'small-stone',
  });
  expect(houses.beginEditing(house, owner)).toBe(true);
  return { houses, owner, house };
}

describe('rich house authoring', () => {
  it('keeps bounded undo/redo history for standard custom-house mutations', () => {
    const { houses, house } = setup();
    houses.addCustomItem(house, 'floor', 0x31F4, 101, 101, 0);
    houses.addCustomItem(house, 'wall', 0x0006, 102, 101, 0);
    expect(houses.customHistory(house)).toMatchObject({ tileCount: 2, canUndo: true, canRedo: false });

    expect(houses.undoCustom(house)).toBe(true);
    expect(house.editing.tiles).toHaveLength(1);
    expect(houses.customHistory(house).canRedo).toBe(true);
    expect(houses.redoCustom(house)).toBe(true);
    expect(house.editing.tiles).toHaveLength(2);
  });

  it('validates graphics, foundation bounds and overlapping pieces', () => {
    const { houses, house } = setup();
    houses.addCustomItem(house, 'floor', 0x31F4, 101, 101, 0);
    houses.addCustomItem(house, 'floor', 0x31F5, 101, 101, 0);
    expect(houses.validateCustom(house)).toMatchObject({ ok: true, tileCount: 2 });
    expect(houses.validateCustom(house).warnings.length).toBeGreaterThan(0);
    // Invalid edits are rejected at the mutation boundary.
    expect(houses.addCustomItem(house, 'item', 0, 500, 500, 500)).toBe(false);
    expect(houses.validateCustom(house).ok).toBe(true);
    // Validation remains a second defensive boundary for imported/corrupt
    // workspaces that did not pass through addCustomItem.
    house.editing.tiles.push({ kind: 'item', g: 0, x: 500, y: 500, z: 500 });
    const invalid = houses.validateCustom(house);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join(' ')).toMatch(/graphic|outside|elevation/i);
  });

  it('copies areas and persists reusable relative templates', () => {
    const { houses, house } = setup();
    houses.addCustomItem(house, 'floor', 0x31F4, 101, 101, 0);
    houses.addCustomItem(house, 'wall', 0x0006, 102, 101, 0);
    expect(houses.copyCustomArea(house, 100, 100, 103, 103)).toBe(2);
    expect(houses.pasteCustomArea(house, 105, 105)).toBe(2);
    expect(house.editing.tiles.some((tile) => tile.x === 106 && tile.y === 106)).toBe(true);

    const saved = houses.saveCustomTemplate(house, 'Corner room', { x1: 100, y1: 100, x2: 103, y2: 103 });
    expect(saved).toMatchObject({ ok: true, tileCount: 2 });
    expect(houses.applyCustomTemplate(house, 'Corner room', 107, 107)).toBe(2);
    expect(house.customTemplates['Corner room'].tiles[0].x).toBeGreaterThanOrEqual(0);
  });
});
