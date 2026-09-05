import { describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { createWorldOpsApi } from '../src/world/ops-api.js';
import { Spawner } from '../src/spawner.js';
import registerWipeWorld from '../../scripts/src/commands/admin/wipeworld.js';

describe('wipeworld', () => {
  it('leaves only player state, purges client ghosts and keeps dormant spawn definitions', () => {
    const world = new World();
    world._createWorldDone = true;
    world._createWorldVersion = 3;
    world._telesApplied = new Set([1]);
    world._xmlSpawnersApplied.add('test-fauna');

    const packets = [];
    const messages = [];
    const player = world.createMobile({ name: 'Admin', x: 1843, y: 2725, z: 0, map: 1 });
    player.isPlayer = true;
    player.client = {
      _visibleItems: new Set(),
      _visibleMobiles: new Set(),
      send: vi.fn((packet) => packets.push(packet)),
      sendSystemMessage: vi.fn((text) => messages.push(text)),
    };

    const backpack = world.createItem({ itemId: 0x0E75, parent: player.serial, layer: 21 });
    const nestedBag = world.createItem({ itemId: 0x0E76, parent: backpack.serial });
    const playerItem = world.createItem({ itemId: 0x0F0E, parent: nestedBag.serial });

    const teleporter = world.createItem({ itemId: 0x1BCB, x: 1844, y: 2725, z: 0, map: 1 });
    teleporter.script = 'teleporter';
    teleporter.isDecoration = true;
    teleporter.visible = false;
    const house = world.createItem({ itemId: 0x4000, x: 1845, y: 2725, z: 0, map: 1 });
    house.house = true;

    const rat = world.createMobile({ name: 'a rat', body: 0x00D7, x: 1844, y: 2726, map: 1 });
    const ratLoot = world.createItem({ itemId: 0x0EED, parent: rat.serial });

    let factorySpawns = 0;
    const spawner = new Spawner(world, (w, kind, pos) => {
      factorySpawns++;
      return w.createMobile({ name: kind, ...pos });
    });
    const group = spawner.add({
      id: 'test-fauna', map: 1,
      rect: { x1: 1840, y1: 2720, x2: 1842, y2: 2722 },
      maxCount: 1, respawnMs: [1000, 2000], kinds: ['rabbit'],
    });
    group.spawnedSerials.add(rat.serial);

    const staleSerial = 0x4000BEEF;
    player.client._visibleItems.add(teleporter.serial);
    player.client._visibleItems.add(staleSerial);
    player.client._visibleMobiles.add(rat.serial);

    let command;
    let refreshes = 0;
    const houses = { reset: vi.fn(() => 1) };
    const systems = {
      maginciaBazaar: { deserializeStalls: vi.fn() },
      bulletinBoard: { deserializeBoards: vi.fn() },
      itemHistory: { clearAll: vi.fn() },
      playerVendor: { rebuildVendorIndex: vi.fn() },
    };
    const requestAuxiliarySave = vi.fn(() => Promise.resolve());
    const api = {
      world,
      ops: createWorldOpsApi(world),
      spawner,
      houses,
      systems,
      commands: {
        register(spec) { command = spec; },
        unregister() {},
      },
      protocol: {
        removeEntity: (serial) => ({ type: 'remove', serial }),
        mobileUpdate: (mobile) => ({ type: 'mobile-update', ...mobile }),
      },
      ctx: { handlers: { refreshSurroundings() { refreshes++; } } },
      persistence: { requestSave: () => null, requestAuxiliarySave, saveDir: 'unused' },
      log: vi.fn(),
    };
    registerWipeWorld(api);
    command.run({ state: player.client, sender: player, args: [] });

    expect([...world.mobiles.values()]).toEqual([player]);
    expect(world.items.has(ratLoot.serial)).toBe(false);
    expect([...world.items.keys()].sort((a, b) => a - b)).toEqual(
      [backpack.serial, nestedBag.serial, playerItem.serial].sort((a, b) => a - b),
    );
    expect(world.spatialNear('teleporter', player, 18).next().done).toBe(true);
    expect(world._createWorldDone).toBe(false);
    expect(world._createWorldVersion).toBe(0);
    expect(world._telesApplied.size).toBe(0);
    expect(world._xmlSpawnersApplied.size).toBe(0);

    expect(spawner.groups.get('test-fauna')).toBe(group);
    expect(group.spawnedSerials.size).toBe(0);
    expect(spawner.validateIndex()).toMatchObject({ ok: true });
    group.nextSpawnAt = 0;
    spawner.tick(10_000);
    expect(factorySpawns).toBe(0);
    world._createWorldDone = true;
    spawner.tick(10_000);
    expect(factorySpawns).toBe(1);

    expect(player.client._visibleItems.size).toBe(0);
    expect(player.client._visibleMobiles.size).toBe(0);
    expect(packets).toEqual(expect.arrayContaining([
      { type: 'remove', serial: teleporter.serial },
      { type: 'remove', serial: staleSerial },
      { type: 'remove', serial: rat.serial },
    ]));
    expect(refreshes).toBe(1);
    expect(houses.reset).toHaveBeenCalledOnce();
    expect(systems.maginciaBazaar.deserializeStalls).toHaveBeenCalledWith([]);
    expect(systems.bulletinBoard.deserializeBoards).toHaveBeenCalledWith({ nextPostSerial: 1, boards: [] });
    expect(systems.itemHistory.clearAll).toHaveBeenCalledOnce();
    expect(systems.playerVendor.rebuildVendorIndex).toHaveBeenCalledWith(world);
    expect(requestAuxiliarySave).toHaveBeenCalledWith('wipeworld');
    expect(messages.at(-1)).toContain('residual world=0 items/0 mobs');
  });
});
