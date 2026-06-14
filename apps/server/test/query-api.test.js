import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { createWorldQueryApi } from '../src/world/query-api.js';

describe('world query api', () => {
  it('uses indexed spatial queries for nearby clients and items', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const center = world.createMobile({ name: 'center', body: 0x190, x: 100, y: 100, z: 0, map: 1 });
    const near = world.createMobile({ name: 'near', body: 0x190, x: 110, y: 100, z: 0, map: 1 });
    const far = world.createMobile({ name: 'far', body: 0x190, x: 140, y: 100, z: 0, map: 1 });
    near.client = { send() {} };
    far.client = { send() {} };
    const nearItem = createItem(world, { itemId: 0x0EED, x: 102, y: 100, z: 0, map: 1 });
    const farItem = createItem(world, { itemId: 0x0EED, x: 200, y: 200, z: 0, map: 1 });

    expect([...query.clientsNear(center, 18, center)].map((m) => m.serial)).toEqual([near.serial]);
    expect([...query.itemsNear(center, 18)].map((it) => it.serial)).toEqual([nearItem.serial]);
    expect([...query.itemsNear(center, 18)].map((it) => it.serial)).not.toContain(farItem.serial);
  });

  it('walks parent descendants through the reverse parent index', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const mob = world.createMobile({ name: 'owner', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const pack = createItem(world, { itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1, parent: mob.serial });
    const bag = createItem(world, { itemId: 0x0E76, x: 0, y: 0, z: 0, map: 1, parent: pack.serial });
    const reagent = createItem(world, { itemId: 0x0F7A, x: 0, y: 0, z: 0, map: 1, parent: bag.serial });

    expect([...query.descendantsOf(mob)].map((it) => it.serial)).toEqual([
      pack.serial,
      bag.serial,
      reagent.serial,
    ]);
    expect([...query.childrenOf(mob)].map((it) => it.serial)).toEqual([pack.serial]);
    expect(query.findChild(pack, (it) => it.itemId === 0x0E76)).toBe(bag);
    expect(query.findDescendant(mob, (it) => it.itemId === 0x0F7A)).toBe(reagent);
  });

  it('fans out one packet to clients in range', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const center = { x: 50, y: 50, z: 0, map: 1 };
    const packets = [];
    const near = world.createMobile({ name: 'near', body: 0x190, x: 55, y: 50, z: 0, map: 1 });
    const far = world.createMobile({ name: 'far', body: 0x190, x: 100, y: 50, z: 0, map: 1 });
    near.client = { send: (pkt) => packets.push(['near', pkt]) };
    far.client = { send: (pkt) => packets.push(['far', pkt]) };

    expect(query.sendToClientsNear(center, { op: 'test' }, 18)).toBe(1);
    expect(packets).toEqual([['near', { op: 'test' }]]);
  });

  it('fans out one packet through the online index', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const packets = [];
    const alice = world.createMobile({ name: 'Alice', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const bob = world.createMobile({ name: 'Bob', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const offline = world.createMobile({ name: 'Offline', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    alice.client = { send: (pkt) => packets.push(['alice', pkt]) };
    bob.client = { send: (pkt) => packets.push(['bob', pkt]) };
    world.enableOnlineMobileIndex();

    expect(query.sendToOnline({ op: 'global' }, (m) => m !== bob)).toBe(1);
    expect(packets).toEqual([['alice', { op: 'global' }]]);
    expect([...query.onlineMobiles()]).toEqual([alice, bob]);
    expect(query.findOnline((m) => m === offline)).toBe(null);
  });

  it('finds online and nearby entities without caller-side scans', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const center = world.createMobile({ name: 'center', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const player = world.createMobile({ name: 'Alice', body: 0x190, x: 12, y: 10, z: 0, map: 1 });
    const banker = world.createMobile({ name: 'banker', body: 0x190, x: 13, y: 10, z: 0, map: 1 });
    const far = world.createMobile({ name: 'far', body: 0x190, x: 80, y: 80, z: 0, map: 1 });
    player.client = { send() {} };
    far.client = { send() {} };
    banker.kind = 'banker';
    const item = createItem(world, { itemId: 0x3E94, x: 11, y: 10, z: 0, map: 1 });
    item.boat = { riders: new Set() };

    expect(query.onlineCount()).toBe(2);
    expect(query.findOnlineByName('alice')).toBe(player);
    expect(query.findClientNear(center, (m) => m.name === 'Alice', 4, center)).toBe(player);
    expect(query.findMobileNear(center, (m) => m.kind === 'banker', 4, center)).toBe(banker);
    expect(query.findMobileNear(center, (m) => m === far, 4)).toBe(null);
    expect(query.findItemNear(center, (it) => !!it.boat, 4)).toBe(item);
    expect(query.mobileBySerial(player.serial)).toBe(player);
    expect(query.itemBySerial(item.serial)).toBe(item);
    expect(query.entityBySerial(item.serial)).toBe(item);
    expect(query.entityBySerial(player.serial)).toBe(player);
    expect(query.findMobile((m) => m.kind === 'banker')).toBe(banker);
    expect(query.findItem((it) => !!it.boat)).toBe(item);
    expect([...query.allMobiles((m) => m.map === 1)].map((m) => m.serial)).toEqual([
      center.serial,
      player.serial,
      banker.serial,
      far.serial,
    ]);
    expect([...query.allItems((it) => it.map === 1)].map((it) => it.serial)).toEqual([item.serial]);
  });
});
