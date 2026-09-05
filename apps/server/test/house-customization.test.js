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

  it('drops the previous owner edit lease when ownership changes', () => {
    const reg = new HouseRegistry();
    const owner = makeOwner(1);
    const house = reg.place(owner, { x1: 0, y1: 0, x2: 5, y2: 5 });
    reg.beginEditing(house, owner);
    reg.addCustomItem(house, 'item', 0x06A5, 1, 1, 7);

    expect(reg.transferOwnership(house, { serial: 2, name: 'Buyer' })).toBe(true);
    expect(house.editing).toBeNull();
    expect(house.ownerSerial).toBe(2);
    expect(house.tiles ?? []).toHaveLength(0);
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
      visible: false, _customHouseId: h.id, _customHouseKind: 'wall',
    });
    expect(delivered).not.toContain(item.serial);
  });

  it('repairs missing derived pieces and removes custom-house orphans on restore', () => {
    const world = new World();
    const original = new HouseRegistry().attachWorld(world);
    const owner = makeOwner(1);
    const house = original.place(owner, {
      x1: 0, y1: 0, x2: 5, y2: 5, z: 0, map: 1, customizable: true,
    });
    original.beginEditing(house, owner);
    original.addCustomItem(house, 'floor', 0x31F4, 1, 1, 0);
    original.addCustomItem(house, 'wall', 0x06A5, 2, 1, 0);
    expect(original.commitCustom(house)).toBe(true);
    const snapshot = original.snapshot();

    world.destroyItem(house.customItemSerials[0]);
    const orphan = world.createItem({
      itemId: 0x1000, x: 4, y: 4, z: 0, map: 1,
      movable: false, _customHouseId: 9999,
    });

    const restored = new HouseRegistry().attachWorld(world);
    expect(restored.restoreSnapshot(snapshot)).toBe(1);
    expect(restored._lastCustomReconcile).toMatchObject({ rebuilt: 1, orphansRemoved: 1, failed: 0 });
    expect(world.items.has(orphan.serial)).toBe(false);
    const repaired = restored.get(house.id);
    expect(repaired.customItemSerials).toHaveLength(2);
    expect(repaired.customItemSerials.every((serial) => world.items.has(serial))).toBe(true);
    expect(repaired.customItemSerials.map((serial) => world.items.get(serial).itemId).sort())
      .toEqual([0x06A5, 0x31F4].sort());
  });

  it('keeps the old committed design when replacement materialization fails', () => {
    const world = new World();
    const reg = new HouseRegistry().attachWorld(world);
    const owner = makeOwner(1);
    const house = reg.place(owner, { x1: 0, y1: 0, x2: 5, y2: 5, map: 1 });
    reg.beginEditing(house, owner);
    reg.addCustomItem(house, 'wall', 0x06A5, 1, 1, 0);
    expect(reg.commitCustom(house)).toBe(true);
    const oldSerial = house.customItemSerials[0];

    reg.beginEditing(house, owner);
    reg.clearCustomTiles(house);
    reg.addCustomItem(house, 'wall', 0x06A6, 2, 1, 0);
    reg.addCustomItem(house, 'floor', 0x31F4, 2, 2, 0);
    const allocate = world.serial.allocItem.bind(world.serial);
    let calls = 0;
    world.serial.allocItem = () => {
      if (++calls === 2) throw new Error('simulated allocation failure');
      return allocate();
    };
    try {
      expect(reg.commitCustom(house)).toBe(false);
    } finally {
      world.serial.allocItem = allocate;
    }
    expect(house.tiles).toEqual([{ kind: 'wall', g: 0x06A5, x: 1, y: 1, z: 0 }]);
    expect(house.editing).toBeTruthy();
    expect(house.customItemSerials).toEqual([oldSerial]);
    expect(world.items.has(oldSerial)).toBe(true);
    expect([...world.items.values()].filter((item) => item._customHouseId === house.id)).toHaveLength(1);
  });

  it('indexes the canonical teleprts catalogue spelling as teleport pieces', () => {
    const reg = new HouseRegistry();
    expect(reg.setCustomPieceCatalog({ teleprts: [{ styles: [{ pieces: [0x1822] }] }] })).toBe(1);
    const owner = makeOwner(1);
    const house = reg.place(owner, { x1: 0, y1: 0, x2: 5, y2: 5, map: 1 });
    reg.beginEditing(house, owner);
    expect(reg.addCustomItem(house, 'teleport', 0x1822, 1, 1, 0)).toBe(true);
    expect(reg.addCustomItem(house, 'wall', 0x1822, 2, 1, 0)).toBe(false);
  });
});
