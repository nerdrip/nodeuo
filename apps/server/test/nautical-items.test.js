import { describe, expect, it, vi } from 'vitest';
import * as cannons from '../src/systems/cannons.js';
import {
  buildCannon,
  buildLobsterTrap,
  buildShipPlans,
} from '../../scripts/src/items/scripts/world/nautical-items.js';

function testWorld(items = [], mobiles = []) {
  return {
    items: new Map(items.map((item) => [item.serial, item])),
    mobiles: new Map(mobiles.map((mobile) => [mobile.serial, mobile])),
    sectors: { moveItem() {} },
    syncSpatialItem() {},
  };
}

function setItemParent(_world, item, parent) { item.parent = parent; }

describe('nautical item scripts', () => {
  it('launches ship plans only at a targeted deep-water tile and consumes the plans', () => {
    const messages = [];
    const user = {
      serial: 1, x: 100, y: 100, z: 0, map: 1,
      client: { sendSystemMessage: (message) => messages.push(message) },
    };
    const pack = { serial: 2, parent: user.serial, layer: 21 };
    const plans = { serial: 3, parent: pack.serial, shipKind: 'galleon-tokuno', name: 'Tokuno Galleon Plans' };
    const world = testWorld([pack, plans], [user]);
    const launched = [];
    const api = {
      world,
      landProvider: { landAt: () => ({ tileId: 0x00A8 }) },
      targeting: { request: (_state, callback) => callback({ x: 104, y: 102, z: -5, map: 1 }) },
      boats: {
        placeGalleon(_api, options) {
          launched.push(options);
          const boat = { serial: 4, x: options.x, y: options.y, z: options.z, map: options.map, name: 'Tokuno galleon', boat: { name: 'Tokuno galleon' } };
          world.items.set(boat.serial, boat);
          return boat;
        },
      },
      items: { destroyItem: (_world, serial) => world.items.delete(serial) },
    };

    expect(buildShipPlans(api).onUse(world, plans, user)).toBe(true);
    expect(launched).toEqual([expect.objectContaining({ kind: 'tokuno', x: 104, y: 102, z: -5, map: 1, ownerSerial: 1 })]);
    expect(world.items.has(plans.serial)).toBe(false);
    expect(messages.at(-1)).toMatch(/launched and anchored/i);
  });

  it('loads and fires a cannon through the engine cannon system', () => {
    const messages = [];
    const damage = vi.fn();
    const user = { serial: 1, x: 0, y: 0, z: 0, map: 1, direction: 2, client: { sendSystemMessage: (message) => messages.push(message) } };
    const victim = { serial: 2, x: 12, y: 0, z: 0, map: 1 };
    const cannon = { serial: 10, x: 0, y: 0, z: 0, map: 1, cannon: { kind: 'light', stage: 'empty', facing: 1 } };
    const powder = { serial: 11, tagId: 'powder-charge', amount: 1, parent: user.serial };
    const ball = { serial: 12, tagId: 'cannon-ball', amount: 1, parent: user.serial };
    const world = testWorld([cannon, powder, ball], [user, victim]);
    const api = {
      world,
      systems: { cannons },
      combat: { damage },
      items: { destroyItem: (_world, serial) => world.items.delete(serial) },
    };
    const script = buildCannon(api);

    expect(script.onDrop(world, cannon, powder, user)).toBe(true);
    expect(cannon.cannon.stage).toBe('powdered');
    expect(script.onDrop(world, cannon, ball, user)).toBe(true);
    expect(cannon.cannon.stage).toBe('primed');
    expect(script.onUse(world, cannon, user)).toBe(true);

    expect(cannon.cannon.stage).toBe('empty');
    expect(damage).toHaveBeenCalledWith(world, victim, expect.any(Number), cannon, { physical: 100 });
    expect(messages.at(-1)).toMatch(/cannon fires/i);
  });

  it('deploys a lobster trap into deep water with a durable catch timer', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-28T20:00:00Z'));
      const messages = [];
      const user = {
        serial: 1, x: 50, y: 50, z: 0, map: 1,
        client: { sendSystemMessage: (message) => messages.push(message) },
      };
      const pack = { serial: 2, parent: user.serial, layer: 21 };
      const trap = { serial: 3, parent: pack.serial, script: 'lobster-trap', x: 0, y: 0, z: 0, map: 1 };
      const world = testWorld([pack, trap], [user]);
      const api = {
        world,
        landProvider: { landAt: () => ({ tileId: 0x00A8 }) },
        targeting: { request: (_state, callback) => callback({ x: 54, y: 52, z: -5, map: 1 }) },
        items: { setItemParent },
      };

      expect(buildLobsterTrap(api).onUse(world, trap, user)).toBe(true);
      expect(trap).toMatchObject({
        parent: null, x: 54, y: 52, z: -5, map: 1, movable: false,
        trap: { kind: 'lobster', ownerSerial: 1, deployed: true },
      });
      expect(trap.trap.readyAt).toBe(Date.now() + 20_000);
      expect(messages.at(-1)).toMatch(/about 20 seconds/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

