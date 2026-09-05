import { describe, expect, it, vi } from 'vitest';
import {
  consumePlacedHouseDeed,
  demolishMultiWithDeed,
  destroyMultiByBrandDetailed,
} from '../../scripts/src/commands/housing/placemulti.js';

function demolitionFixture({ failSerial = 0 } = {}) {
  let nextSerial = 0x5000;
  const events = [];
  const world = { items: new Map(), mobiles: new Map() };
  const state = {
    send(packet) { events.push(packet.kind); },
    sendSystemMessage(message) { events.push(`message:${message}`); },
  };
  const owner = { serial: 0x1001, name: 'Owner', x: 100, y: 100, z: 0, map: 1, client: state };
  const pack = { serial: 0x2001, itemId: 0x0E75, layer: 21, parent: owner.serial, map: 1 };
  const observer = {
    serial: 0x1002, x: 101, y: 100, z: 0, map: 1,
    client: { send() { throw new Error('stale socket'); } },
  };
  world.mobiles.set(owner.serial, owner);
  world.mobiles.set(observer.serial, observer);
  world.items.set(pack.serial, pack);

  const addPart = (serial) => {
    const item = {
      serial, itemId: 0x1000, x: 100, y: 100, z: 0, map: 1,
      _multi: 0x006E, _multiInstance: 0x4001,
    };
    world.items.set(serial, item);
    return item;
  };
  addPart(0x4001);
  addPart(0x4002);

  const api = {
    world,
    log() {},
    protocol: {
      removeEntity: (serial) => ({ kind: `remove:${serial}` }),
      containerContentUpdate: () => ({ kind: 'deed-reveal' }),
    },
    game: {
      allItems: () => world.items.values(),
      allMobiles: () => world.mobiles.values(),
      itemBySerial: (serial) => world.items.get(Number(serial) >>> 0) ?? null,
      inventory: { findBackpack: () => pack },
      mobile: {
        giveItem(_mobile, data, options) {
          events.push(options.notify ? 'deed-visible-create' : 'deed-staged');
          const item = { ...data, serial: nextSerial++, parent: pack.serial, map: 1 };
          world.items.set(item.serial, item);
          return item;
        },
      },
      item: {
        destroy(serialValue) {
          const serial = Number(serialValue) >>> 0;
          events.push(`destroy:${serial}`);
          if (serial === failSerial) return false;
          return world.items.delete(serial);
        },
      },
    },
  };
  return { api, world, state, owner, events };
}

describe('house demolition transaction', () => {
  it('removes a placed deed from the authoritative world and an open backpack', () => {
    const { api, world, state, events } = demolitionFixture();
    const deed = { serial: 0x6001, itemId: 0x14F0, parent: 0x2001, script: 'house-deed' };
    world.items.set(deed.serial, deed);

    expect(consumePlacedHouseDeed(api, state, deed.serial)).toBe(true);
    expect(world.items.has(deed.serial)).toBe(false);
    expect(events).toContain(`remove:${deed.serial}`);
  });

  it('removes authoritative items even when a nearby client send throws', () => {
    const { api, world } = demolitionFixture();
    const result = destroyMultiByBrandDetailed(api, 0x006E, 1, 0x4001);

    expect(result).toMatchObject({ expected: 2, removed: 2, failed: [] });
    expect(result.notificationErrors).toBeGreaterThan(0);
    expect(world.items.has(0x4001)).toBe(false);
    expect(world.items.has(0x4002)).toBe(false);
  });

  it('removes the housing registry record only after complete editor undo', () => {
    const { api, world } = demolitionFixture();
    const remove = vi.fn(() => true);
    api.houses = {
      houseByMultiInstance: vi.fn(() => ({ id: 77 })),
      remove,
    };

    const result = destroyMultiByBrandDetailed(api, 0x006E, 1, 0x4001, {
      removeRegistry: true,
    });

    expect(result).toMatchObject({ expected: 2, removed: 2, failed: [], registryRemoved: true });
    expect(api.houses.houseByMultiInstance).toHaveBeenCalledWith(0x4001);
    expect(remove).toHaveBeenCalledWith(77);
    expect(world.items.size).toBe(1); // only the backpack fixture remains
  });

  it('keeps the housing registry record when structure removal is incomplete', () => {
    const { api } = demolitionFixture({ failSerial: 0x4002 });
    const remove = vi.fn(() => true);
    api.houses = { houseByMultiInstance: () => ({ id: 77 }), remove };

    const result = destroyMultiByBrandDetailed(api, 0x006E, 1, 0x4001, {
      removeRegistry: true,
    });

    expect(result).toMatchObject({ expected: 2, removed: 1, failed: [0x4002], registryRemoved: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it('reveals the returned deed only after every house part is gone', () => {
    const { api, world, state, owner, events } = demolitionFixture();
    const result = demolishMultiWithDeed(api, state, owner, {
      multiId: 0x006E,
      facet: 1,
      instanceId: 0x4001,
      name: 'deed to test house',
    });

    expect(result).toMatchObject({ ok: true, expected: 2, removed: 2, failed: [] });
    expect(result.deed).toMatchObject({ _deedMulti: 0x006E, parent: 0x2001 });
    expect(world.items.has(result.deed.serial)).toBe(true);
    expect(events.indexOf('deed-reveal')).toBeGreaterThan(events.indexOf('destroy:16386'));
    expect(events).not.toContain('deed-visible-create');
  });

  it('rolls back the staged deed when any structure part cannot be removed', () => {
    const { api, world, state, owner, events } = demolitionFixture({ failSerial: 0x4002 });
    const result = demolishMultiWithDeed(api, state, owner, {
      multiId: 0x006E,
      facet: 1,
      instanceId: 0x4001,
    });

    expect(result).toMatchObject({ ok: false, reason: 'incomplete-removal', expected: 2, removed: 1 });
    expect(result.failed).toEqual([0x4002]);
    expect(world.items.has(0x4002)).toBe(true);
    expect([...world.items.values()].some((item) => item._deedMulti === 0x006E)).toBe(false);
    expect(events).not.toContain('deed-reveal');
  });
});
