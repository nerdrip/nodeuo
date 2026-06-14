import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';

describe('world persistence', () => {
  it('snapshot + restore round-trips mobiles and items', () => {
    const w1 = new World();
    const mob = w1.createMobile({ name: 'Alice' });
    mob.x = 100; mob.y = 200; mob.z = 5;
    const torch = createItem(w1, { itemId: 0x0F0B, x: 101, y: 200, z: 5 });
    const sword = createItem(w1, { itemId: 0x13B9, hue: 0x0058, x: 102, y: 200, z: 5 });

    const snap = snapshotWorld(w1);
    expect(snap.version).toBe(1);
    expect(snap.mobiles).toHaveLength(1);
    expect(snap.items).toHaveLength(2);

    // Round-trip via JSON.
    const json = JSON.parse(JSON.stringify(snap));

    const w2 = new World();
    restoreWorld(w2, json);

    expect(w2.mobiles.size).toBe(1);
    expect(w2.items.size).toBe(2);
    const restoredMob = w2.mobiles.get(mob.serial);
    expect(restoredMob.name).toBe('Alice');
    expect(restoredMob.x).toBe(100);
    expect(restoredMob.client).toBeNull();
    expect(w2.items.get(torch.serial).itemId).toBe(0x0F0B);
    expect(w2.items.get(sword.serial).hue).toBe(0x0058);

    // Serial allocator must not reuse existing serials.
    const newMob = w2.createMobile({ name: 'Bob' });
    expect(newMob.serial).toBeGreaterThan(mob.serial);
    const newItem = createItem(w2, { itemId: 1, x: 0, y: 0, z: 0 });
    expect(newItem.serial).toBeGreaterThan(sword.serial);
  });

  it('rejects unknown save version', () => {
    const w = new World();
    expect(() => restoreWorld(w, { version: 99, mobiles: [], items: [] }))
      .toThrow(/unsupported save version/);
  });

  it('drops items whose parent serial does not resolve to any mobile or item', () => {
    // Regression for S-04. Saves used to silently lose items whose parent
    // pointed at a purged container; the load path must at least drop those
    // items to the ground so the player can recover them.
    const w = new World();
    const mob = w.createMobile({ name: 'Ghost' });
    mob.x = 10; mob.y = 20; mob.z = 0;
    const orphan = createItem(w, { itemId: 0x1B76, x: 0, y: 0, z: 0 });
    orphan.parent = 0x7F123456; // nonexistent parent serial
    orphan.layer = 21;
    orphan.gridX = 5; orphan.gridY = 5;

    const snap = JSON.parse(JSON.stringify(snapshotWorld(w)));
    const w2 = new World();
    restoreWorld(w2, snap);

    const restored = w2.items.get(orphan.serial);
    expect(restored).toBeDefined();
    expect(restored.parent).toBeNull();
    expect(restored.layer).toBe(0);
    expect(restored.gridX).toBeUndefined();
  });

  it('rejects mobiles and items whose serials fall outside their valid range', () => {
    // Regression for S-04. Without this, a save hand-edited to contain an
    // item serial inside the mobile range (or vice versa) corrupted world
    // lookups that rely on isItemSerial / isMobileSerial dispatch.
    const w = new World();
    restoreWorld(w, {
      version: 1,
      mobiles: [
        { serial: 0x80000001, name: 'OutOfRange', x: 0, y: 0, z: 0 }, // > 0x3FFFFFFF
        { serial: 0x00000002, name: 'Valid',      x: 0, y: 0, z: 0 },
      ],
      items: [
        { serial: 0x00000003, itemId: 0x0F0B,     x: 0, y: 0, z: 0 }, // in mobile range
        { serial: 0x40000004, itemId: 0x0F0B,     x: 0, y: 0, z: 0 },
      ],
      serials: { nextMobile: 1, nextItem: 0x40000000 },
    });

    expect(w.mobiles.size).toBe(1);
    expect(w.mobiles.has(0x00000002)).toBe(true);
    expect(w.items.size).toBe(1);
    expect(w.items.has(0x40000004)).toBe(true);
  });
});
