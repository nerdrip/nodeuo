import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { restoreWorld, snapshotWorld } from '../src/world/persistence.js';
import {
  houseDeedPlacementHue, stampMultiAt,
} from '../../scripts/src/commands/housing/placemulti.js';
import { applyAclToTiles, newAclFor } from '../../scripts/src/items/behaviors/house-acl.js';
import { HouseRegistry } from '../src/systems/housing/houses.js';
import {
  ensureHouseForMulti, registerMultiHouse,
} from '../../scripts/src/commands/housing/multi-house-bridge.js';

const WALL = 0x1000;
const DOOR = 0x06A5;

function makeApi() {
  const world = new World();
  const delivered = [];
  const observer = world.createMobile({ name: 'observer', x: 100, y: 100, z: 0, map: 1 });
  observer.client = {
    _visibleItems: new Set(),
    sendItem(item) {
      delivered.push({ serial: item.serial, multiId: item.multiId, itemId: item.itemId });
      return item.visible !== false;
    },
  };

  const statics = [];
  statics[0x0001] = { name: 'No Draw', flags: 0, height: 0 };
  statics[WALL] = { name: 'stone wall', flags: 1 << 6, height: 20 };
  statics[DOOR] = { name: 'wooden door', flags: 1 << 29, height: 20 };

  return {
    api: {
      world,
      items: { createItem },
      tileData: { table: () => ({ statics }) },
    },
    delivered,
  };
}

describe('canonical multi placement', () => {
  it('keeps the dyed deed icon hue separate from canonical house art', () => {
    expect(houseDeedPlacementHue({ hue: 0x0481 })).toBe(0);
    expect(houseDeedPlacementHue({ hue: 0x0000 })).toBe(0);
  });

  it('sends one type-2 anchor, compacts immutable collision, and preserves dynamic pieces', () => {
    const { api, delivered } = makeApi();
    const tiles = [
      { id: WALL, x: 0, y: 0, z: 0, visible: true },
      { id: DOOR, x: 1, y: 0, z: 0, visible: false },
      { id: 0x0001, x: 2, y: 0, z: 0, visible: false },
    ];

    const result = stampMultiAt(api, 0, 0, tiles, 100, 100, 0, 1);
    const parts = [...api.world.items.values()]
      .filter((item) => item._multiInstance === result.instanceId && !item._multiAnchor);

    expect(result.anchor).toMatchObject({
      itemId: 0,
      multiId: 0,
      _multi: 0,
      _multiAnchor: true,
      _multiInstance: result.instanceId,
      visible: true,
    });
    expect(result.placed).toBe(2);
    expect(parts).toHaveLength(1);
    expect(result.anchor._multiComponentCount).toBe(2);
    expect(result.anchor._multiCollision).toEqual([[0, 0, 0, 20]]);
    expect(parts.find((item) => item.itemId === DOOR)).toMatchObject({ visible: true });
    expect(parts.find((item) => item.itemId === DOOR).door).toBeTruthy();
    expect(delivered).toEqual([
      { serial: result.anchor.serial, multiId: 0, itemId: 0 },
      { serial: parts.find((item) => item.itemId === DOOR).serial, multiId: undefined, itemId: DOOR },
    ]);
  });

  it('isolates two placements of the same template for ACL operations', () => {
    const { api } = makeApi();
    const tiles = [{ id: WALL, x: 0, y: 0, z: 0, visible: true }];
    const first = stampMultiAt(api, 0x006E, 0, tiles, 100, 100, 0, 1);
    const second = stampMultiAt(api, 0x006E, 0, tiles, 110, 100, 0, 1);
    const owner = api.world.createMobile({ name: 'owner', x: 100, y: 100, z: 0, map: 1 });
    const acl = newAclFor(owner);

    expect(first.instanceId).not.toBe(second.instanceId);
    expect(applyAclToTiles(api.world, 0x006E, 1, acl, first.instanceId)).toBe(1);
    for (const item of api.world.items.values()) {
      if (item._multiInstance === first.instanceId) expect(item._multiAcl).toBe(acl);
      if (item._multiInstance === second.instanceId) expect(item._multiAcl).toBeUndefined();
    }
  });

  it('round-trips anchor identity and compact collision through persistence', () => {
    const { api } = makeApi();
    const result = stampMultiAt(
      api,
      0x006E,
      0x0481,
      [{ id: WALL, x: 0, y: 0, z: 0, visible: true }],
      100,
      100,
      0,
      1,
    );
    const owner = api.world.createMobile({ name: 'owner', x: 100, y: 100, z: 0, map: 1 });
    const acl = newAclFor(owner);
    expect(applyAclToTiles(api.world, 0x006E, 1, acl, result.instanceId)).toBe(1);

    const snapshot = snapshotWorld(api.world);
    const savedParts = snapshot.items.filter((item) => item._multiInstance === result.instanceId);
    expect(savedParts.find((item) => item._multiAnchor)).toHaveProperty('_multiAcl');
    expect(savedParts).toHaveLength(1);

    const restoredWorld = new World();
    restoreWorld(restoredWorld, JSON.parse(JSON.stringify(snapshot)));

    const anchor = restoredWorld.items.get(result.anchor.serial);
    expect(anchor).toMatchObject({
      multiId: 0x006E,
      _multi: 0x006E,
      _multiAnchor: true,
      _multiInstance: result.instanceId,
      hue: 0x0481,
      visible: true,
    });
    expect(anchor._multiCollision).toEqual([[0, 0, 0, 20]]);
    expect([...restoredWorld.multiSpatial.blockersAt(1, 100, 100)]).toHaveLength(1);
    expect(anchor._multiAcl).toEqual(acl);
  });

  it('registers a placed house multi with the placer as owner', () => {
    const { api } = makeApi();
    api.houses = new HouseRegistry();
    const owner = api.world.createMobile({ name: 'Architect', x: 100, y: 100, z: 0, map: 1 });
    owner.client = { account: { accessLevel: 'GM' } };
    const result = stampMultiAt(api, 0x006E, 0x0481, [
      { id: WALL, x: -2, y: -1, z: 0, visible: true },
      { id: DOOR, x: 2, y: 1, z: 0, visible: false },
    ], 100, 100, 0, 1);

    const house = registerMultiHouse(api, result.anchor, owner, { source: 'test' });
    expect(house).toMatchObject({
      ownerSerial: owner.serial,
      multiId: 0x006E,
      multiSerial: result.anchor.serial,
      multiInstance: result.instanceId,
      customizable: false,
      source: 'test',
    });
    expect(api.houses.houseAt(98, 99, 1)).toBe(house);
    for (const item of api.world.items.values()) {
      if (item._multiInstance !== result.instanceId) continue;
      expect(item.hue).toBe(0);
      expect(item._multiHouseId).toBe(house.id);
      expect(item._multiAcl?.owner?.serial).toBe(owner.serial);
    }
  });

  it('lets staff adopt a legacy unowned house from its sign', () => {
    const { api } = makeApi();
    api.houses = new HouseRegistry();
    const admin = api.world.createMobile({ name: 'Admin', x: 100, y: 100, z: 0, map: 1 });
    admin.client = { account: { accessLevel: 'Admin' }, sendSystemMessage() {} };
    const result = stampMultiAt(api, 0x006E, 0, [
      { id: WALL, x: 0, y: 0, z: 0, visible: true },
      { id: 0x0BC8, x: 1, y: 1, z: 0, visible: false },
    ], 100, 100, 0, 1);
    const sign = [...api.world.items.values()].find(
      (item) => item._multiInstance === result.instanceId && item.itemId === 0x0BC8,
    );

    const house = ensureHouseForMulti(api, sign, admin);
    expect(house?.ownerSerial).toBe(admin.serial);
    expect(house?.source).toBe('legacy-migration');
    expect(api.houses.housesOf(admin.serial)).toEqual([house]);
  });
});
