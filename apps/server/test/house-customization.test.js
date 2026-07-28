import { describe, it, expect } from 'vitest';
import { HouseRegistry } from '../src/systems/housing/houses.js';
import { World } from '../src/world/world.js';

function makeOwner(serial = 1) { return { serial, name: 'Owner' }; }

describe('house customization (per-tile)', () => {
  it('beginEditing rejects non-owners', () => {
    const reg = new HouseRegistry();
    const h = reg.place(makeOwner(1), { x1: 0, y1: 0, x2: 5, y2: 5 });
    expect(reg.beginEditing(h, makeOwner(99))).toBe(false);
    expect(reg.beginEditing(h, makeOwner(1))).toBe(true);
    expect(h.editing).toBeTruthy();
  });

  it('add/remove tiles in editing buffer', () => {
    const reg = new HouseRegistry();
    const h = reg.place(makeOwner(1), { x1: 0, y1: 0, x2: 5, y2: 5 });
    reg.beginEditing(h, makeOwner(1));
    reg.addCustomItem(h, 'item', 0x06A5, 1, 1, 0);
    reg.addCustomItem(h, 'roof', 0x65A0, 2, 2, 7);
    expect(h.editing.tiles.length).toBe(2);
    expect(reg.removeCustomItem(h, 0x06A5, 1, 1, 0)).toBe(1);
    expect(h.editing.tiles.length).toBe(1);
  });

  it('backup + restore round-trip', () => {
    const reg = new HouseRegistry();
    const h = reg.place(makeOwner(1), { x1: 0, y1: 0, x2: 5, y2: 5 });
    reg.beginEditing(h, makeOwner(1));
    reg.addCustomItem(h, 'item', 0x06A5, 1, 1);
    reg.backupCustom(h);
    reg.addCustomItem(h, 'item', 0x06A6, 2, 2);
    reg.removeCustomItem(h, 0x06A5, 1, 1, 0);
    expect(h.editing.tiles.length).toBe(1);
    reg.restoreCustom(h);
    expect(h.editing.tiles.length).toBe(1);
    expect(h.editing.tiles[0].g).toBe(0x06A5);
  });

  it('commit promotes editing -> tiles + bumps revision', () => {
    const reg = new HouseRegistry();
    const h = reg.place(makeOwner(1), { x1: 0, y1: 0, x2: 5, y2: 5 });
    reg.beginEditing(h, makeOwner(1));
    reg.addCustomItem(h, 'item', 0x06A5, 1, 1);
    expect(h.tiles?.length ?? 0).toBe(0);
    const r0 = h.revision ?? 0;
    expect(reg.commitCustom(h)).toBe(true);
    expect(h.tiles.length).toBe(1);
    expect(h.editing).toBeNull();
    expect(h.revision).toBeGreaterThan(r0);
  });

  it('revert drops editing buffer', () => {
    const reg = new HouseRegistry();
    const h = reg.place(makeOwner(1), { x1: 0, y1: 0, x2: 5, y2: 5 });
    reg.beginEditing(h, makeOwner(1));
    reg.addCustomItem(h, 'item', 0x06A5, 1, 1);
    expect(reg.revertCustom(h)).toBe(true);
    expect(h.editing).toBeNull();
  });

  it('clearCustomTiles empties the editing buffer', () => {
    const reg = new HouseRegistry();
    const h = reg.place(makeOwner(1), { x1: 0, y1: 0, x2: 5, y2: 5 });
    reg.beginEditing(h, makeOwner(1));
    reg.addCustomItem(h, 'item', 0x06A5, 1, 1);
    reg.addCustomItem(h, 'item', 0x06A6, 2, 2);
    reg.clearCustomTiles(h);
    expect(h.editing.tiles.length).toBe(0);
  });

  it('materializes committed custom tiles into the live world', () => {
    const world = new World();
    const observer = world.createMobile({ name: 'Observer', x: 2, y: 2, z: 0, map: 1 });
    const delivered = [];
    observer.client = { sendItem: (item) => delivered.push(item.serial), sendRemove() {} };
    const reg = new HouseRegistry().attachWorld(world);
    const owner = makeOwner(1);
    const h = reg.place(owner, { x1: 0, y1: 0, x2: 5, y2: 5, z: 10, customizable: true });
    reg.beginEditing(h, owner);
    reg.addCustomItem(h, 'wall', 0x06A5, 2, 2, 17);

    expect(reg.commitCustom(h)).toBe(true);
    expect(h.customItemSerials).toHaveLength(1);
    const item = world.items.get(h.customItemSerials[0]);
    expect(item).toMatchObject({
      itemId: 0x06A5, x: 2, y: 2, z: 17, movable: false,
      _customHouseId: h.id,
    });
    expect(delivered).toContain(item.serial);
  });
});
