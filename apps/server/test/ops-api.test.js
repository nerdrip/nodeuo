import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { createWorldOpsApi } from '../src/world/ops-api.js';
import { createWorldQueryApi } from '../src/world/query-api.js';

describe('world ops api', () => {
  it('moves mobiles while keeping the sector index current', () => {
    const world = new World();
    const ops = createWorldOpsApi(world);
    const query = createWorldQueryApi(world);
    const mob = world.createMobile({ name: 'traveler', body: 0x190, x: 10, y: 10, z: 0, map: 1 });

    const result = ops.moveMobile(mob, { x: 100, y: 100, z: 5, map: 1 });

    expect(result.mob).toBe(mob);
    expect([...query.mobilesNear({ x: 10, y: 10, map: 1 }, 0)]).toEqual([]);
    expect([...query.mobilesAt({ x: 100, y: 100, map: 1 })]).toEqual([mob]);
    expect(mob.z).toBe(5);
  });

  it('moves items between ground and parent index safely', () => {
    const world = new World();
    const ops = createWorldOpsApi(world);
    const query = createWorldQueryApi(world);
    const mob = world.createMobile({ name: 'owner', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const item = createItem(world, { itemId: 0x0EED, x: 10, y: 10, z: 0, map: 1 });

    ops.setItemParent(item, mob.serial);

    expect([...query.itemsNear({ x: 10, y: 10, map: 1 }, 0)]).toEqual([]);
    expect([...query.descendantsOf(mob)].map((it) => it.serial)).toEqual([item.serial]);

    ops.moveItem(item, { parent: null, x: 12, y: 12, z: 0, map: 1 });

    expect([...query.descendantsOf(mob)]).toEqual([]);
    expect([...query.itemsAt({ x: 12, y: 12, map: 1 })]).toEqual([item]);
  });

  it('destroys through canonical world paths', () => {
    const world = new World();
    const ops = createWorldOpsApi(world);
    const item = createItem(world, { itemId: 0x0EED, x: 1, y: 1, z: 0, map: 1 });
    const mob = world.createMobile({ name: 'gone', body: 0x190, x: 1, y: 1, z: 0, map: 1 });

    expect(ops.destroyItem(item)).toBe(true);
    expect(ops.destroyMobile(mob)).toBe(true);
    expect(world.items.has(item.serial)).toBe(false);
    expect(world.mobiles.has(mob.serial)).toBe(false);
  });
});
