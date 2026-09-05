import { describe, it, expect, afterEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem, destroyItem } from '../src/world/items.js';
import { applyNavalImpact, placeCannon } from '../src/systems/cannons.js';
import {
  boatPlacementForMultiId, placeCanonicalBoat, placeGalleon, removeEditorBoat, startBoatSystem,
} from '../src/systems/boats.js';

const running = [];

afterEach(() => {
  while (running.length) running.pop().stop();
});

function makeApi() {
  const world = new World();
  const worldItemPackets = [];
  return {
    world,
    worldItemPackets,
    items: { createItem, destroyItem },
    systems: { cannons: { placeCannon } },
    isWaterAt: () => true,
    protocol: {
      worldItemSA: (data) => {
        worldItemPackets.push(data);
        return new Uint8Array([0xF3]);
      },
      mobileMoving: () => new Uint8Array([0x77]),
      unicodeMessage: () => new Uint8Array([0xAE]),
    },
  };
}

describe('boat system parity', () => {
  it('maps every canonical editor boat family to a playable hull and removes an unchanged placement', () => {
    const api = makeApi();
    expect(boatPlacementForMultiId(0x06)).toMatchObject({ kind: 'smallDragon', facing: 'S', multiId: 0x06 });
    expect(boatPlacementForMultiId(0x3F)).toMatchObject({ kind: 'rowboat', facing: 'W', multiId: 0x3F });
    expect(boatPlacementForMultiId(0x47)).toMatchObject({ kind: 'britannian', facing: 'W', multiId: 0x43 });
    expect(boatPlacementForMultiId(0x64)).toBeNull();

    const boat = placeCanonicalBoat(api, { multiId: 0x06, x: 100, y: 100, z: 0, map: 1, ownerSerial: 7 });
    expect(boat).toMatchObject({ multiId: 0x06, boat: { hullKind: 'smallDragon', facing: 'S', anchored: true } });
    const result = removeEditorBoat(api, boat.serial);
    expect(result).toMatchObject({ ok: true, removed: 2, expected: 2, failed: [] });
    expect(api.world.items.size).toBe(0);
  });

  it('places galleon cannons and planks as attached world objects', () => {
    const api = makeApi();

    const boat = placeGalleon(api, {
      kind: 'britannian',
      x: 100,
      y: 100,
      z: 0,
      map: 1,
      ownerSerial: 0x1001,
      name: 'Nightwind',
    });

    expect(boat.boat.name).toBe('Nightwind');
    expect(boat.boat.cannons).toHaveLength(6);
    expect(boat.boat.planks).toHaveLength(2);
    for (const serial of [...boat.boat.cannons, ...boat.boat.planks]) {
      expect(api.world.items.has(serial)).toBe(true);
    }
    const cannon = api.world.items.get(boat.boat.cannons[0]);
    const plank = api.world.items.get(boat.boat.planks[0]);
    expect(cannon._mountSerial).toBe(boat.serial);
    expect(plank.boatPlank.boatSerial).toBe(boat.serial);
  });

  it('migrates restored static-art hull ids before clients can see them', () => {
    const api = makeApi();
    const legacyBoat = createItem(api.world, {
      itemId: 0x3E96,
      x: 100,
      y: 100,
      z: 0,
      map: 1,
      boat: {
        facing: 'N', hullKind: 'small', riders: [], planks: [], cannons: [], anchored: true,
      },
    });

    const boats = startBoatSystem(api);
    running.push(boats);
    expect(legacyBoat).toMatchObject({ itemId: 0, artId: 0, multiId: 0 });
    expect(api.world._boats.has(legacyBoat.serial)).toBe(true);
  });

  it('moves planks, cannons, tillerman and riders with the sailing hull', () => {
    const api = makeApi();
    const boat = placeGalleon(api, { kind: 'tokuno', x: 200, y: 200, z: 0, map: 1 });
    const rider = api.world.createMobile({ x: 200, y: 200, z: 0, map: 1 });
    const tiller = api.world.createMobile({ name: 'a tillerman', x: 200, y: 199, z: 0, map: 1 });
    boat.boat.riders.add(rider.serial);
    boat.boat.anchored = false;

    const boats = startBoatSystem(api);
    running.push(boats);
    boats.setTillerman(boat, tiller);

    const plank = api.world.items.get(boat.boat.planks[0]);
    const cannon = api.world.items.get(boat.boat.cannons[0]);
    const before = {
      boatY: boat.y,
      riderY: rider.y,
      tillerY: tiller.y,
      plankY: plank.y,
      cannonY: cannon.y,
    };

    expect(boats.sailOnce(boat)).toBe(true);

    expect(boat.y).toBe(before.boatY - 1);
    expect(rider.y).toBe(before.riderY - 1);
    expect(tiller.y).toBe(before.tillerY - 1);
    expect(plank.y).toBe(before.plankY - 1);
    expect(cannon.y).toBe(before.cannonY - 1);
  });

  it('prunes stale rider registrations instead of teleporting characters back to deck', () => {
    const api = makeApi();
    const boat = placeGalleon(api, { kind: 'small', x: 200, y: 200, z: 0, map: 1 });
    const ashore = api.world.createMobile({ x: 240, y: 240, z: 0, map: 1 });
    ashore._boardedBoat = boat.serial;
    boat.boat.riders.add(ashore.serial);
    boat.boat.anchored = false;
    const boats = startBoatSystem(api);
    running.push(boats);

    expect(boats.sailOnce(boat)).toBe(true);
    expect(ashore).toMatchObject({ x: 240, y: 240 });
    expect(ashore._boardedBoat).toBeUndefined();
    expect(boat.boat.riders.has(ashore.serial)).toBe(false);
  });

  it('dry-docking removes hull attachments and returns a named deed', () => {
    const api = makeApi();
    const owner = api.world.createMobile({ x: 310, y: 300, z: 0, map: 1 });
    const backpack = createItem(api.world, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1,
      parent: owner.serial, layer: 21, gumpId: 0x003C,
    });
    const boat = placeGalleon(api, {
      kind: 'gargish',
      x: 300,
      y: 300,
      z: 0,
      map: 1,
      ownerSerial: owner.serial,
      name: 'Glass Wake',
    });
    const oldKey = createItem(api.world, {
      itemId: 0x1010, x: 0, y: 0, z: 0, map: 1,
      parent: backpack.serial, boatKey: boat.serial,
    });
    boat.boat.keys.push(oldKey.serial);
    const tiller = api.world.createMobile({ name: 'a tillerman', x: 300, y: 299, z: 0, map: 1 });
    const boats = startBoatSystem(api);
    running.push(boats);
    boats.setTillerman(boat, tiller);

    const attachments = [...boat.boat.cannons, ...boat.boat.planks];
    const r = boats.dryDockGalleon(api, boat, owner);

    expect(r.ok).toBe(true);
    expect(api.world.items.has(boat.serial)).toBe(false);
    for (const serial of attachments) {
      expect(api.world.items.has(serial)).toBe(false);
    }
    expect(api.world.mobiles.has(tiller.serial)).toBe(false);
    expect(api.world.items.has(oldKey.serial)).toBe(false);
    const deed = api.world.items.get(r.deedSerial);
    expect(deed.script).toBe('servuo-boat-deed');
    expect(deed.parent).toBe(backpack.serial);
    expect(deed.boatDeed).toMatchObject({
      hullKind: 'gargish',
      name: 'Glass Wake',
      ownerSerial: owner.serial,
    });
  });

  it('refuses to dry-dock while even an unregistered owner stands on deck', () => {
    const api = makeApi();
    const owner = api.world.createMobile({ x: 300, y: 300, z: 0, map: 1 });
    createItem(api.world, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1,
      parent: owner.serial, layer: 21, gumpId: 0x003C,
    });
    const boat = placeGalleon(api, {
      kind: 'small', x: 300, y: 300, z: 0, map: 1,
      ownerSerial: owner.serial,
    });
    const boats = startBoatSystem(api);
    running.push(boats);

    expect(boats.dryDockGalleon(api, boat, owner)).toMatchObject({
      ok: false, reason: 'passengers-aboard',
    });
    expect(api.world.items.has(boat.serial)).toBe(true);
  });

  it('pilot rights accept owners and carried key items, including nested keys', () => {
    const api = makeApi();
    const owner = api.world.createMobile({ x: 1, y: 1, map: 1 });
    const crew = api.world.createMobile({ x: 1, y: 1, map: 1 });
    const boat = placeGalleon(api, {
      kind: 'galleon',
      x: 20,
      y: 20,
      z: 0,
      map: 1,
      ownerSerial: owner.serial,
    });
    const boats = startBoatSystem(api);
    running.push(boats);

    expect(boats.hasPilotRights(boat, owner)).toBe(true);
    expect(boats.hasPilotRights(boat, crew)).toBe(false);

    const bag = api.world.createItem({ itemId: 0x0E76, x: 0, y: 0, z: 0, map: 1, parent: crew.serial });
    const key = api.world.createItem({
      itemId: 0x100E,
      x: 0,
      y: 0,
      z: 0,
      map: 1,
      parent: bag.serial,
      boatKey: boat.serial,
    });
    boat.boat.keys.push(key.serial);

    expect(boats.hasPilotRights(boat, crew)).toBe(true);
  });

  it('checks the complete hull footprint and never carries immovable structures', () => {
    const api = makeApi();
    createItem(api.world, {
      itemId: 0x1000, x: 102, y: 100, z: 0, map: 1,
      solid: true, movable: false,
    });
    expect(() => placeGalleon(api, {
      kind: 'small', x: 100, y: 100, z: 0, map: 1, facing: 'N',
    })).toThrow(/collides with an item/i);

    const clearApi = makeApi();
    const boat = placeGalleon(clearApi, { kind: 'small', x: 200, y: 200, z: 0, map: 1 });
    const wall = createItem(clearApi.world, {
      itemId: 0x1000, x: 201, y: 200, z: 0, map: 1,
      solid: true, movable: false,
    });
    boat.boat.anchored = false;
    const boats = startBoatSystem(clearApi);
    running.push(boats);
    expect(boats.sailOnce(boat)).toBe(false);
    expect(wall).toMatchObject({ x: 201, y: 200 });
  });

  it('applies hull armor, exposes condition stats, and slows a damaged hull', () => {
    const api = makeApi();
    const boat = placeGalleon(api, { kind: 'britannian', x: 50, y: 50, map: 1 });
    const boats = startBoatSystem(api);
    running.push(boats);

    expect(boats.stats(boat)).toMatchObject({
      hullKind: 'britannian', hp: 4000, armorPercent: 28, condition: 'sound',
    });
    expect(boats.damage(boat, 1000)).toBe(false);
    expect(boat.boat.lastDamage).toMatchObject({ raw: 1000, applied: 720, damageType: 'physical' });
    expect(boats.stats(boat)).toMatchObject({ hp: 3280, condition: 'sound' });
    boats.damage(boat, 2000, { ignoreArmor: true });
    expect(boats.stats(boat).condition).toBe('damaged');
    expect(boats.stats(boat).speedMultiplier).toBeLessThan(0.82);
  });

  it('rotates mounted objects and cannon directions with the hull', () => {
    const api = makeApi();
    const boat = placeGalleon(api, { kind: 'tokuno', x: 100, y: 100, map: 1 });
    const boats = startBoatSystem(api);
    running.push(boats);
    const cannon = api.world.items.get(boat.boat.cannons[0]);
    const before = { dx: cannon.x - boat.x, dy: cannon.y - boat.y, facing: cannon.cannon.facing };

    expect(boats.setFacing(boat, 'E')).toBe(true);
    expect(boat.multiId).toBe(0x31);
    expect({ dx: cannon.x - boat.x, dy: cannon.y - boat.y }).toEqual({ dx: -before.dy, dy: before.dx });
    expect(cannon.cannon.facing).toBe((before.facing + 1) & 3);
    expect(api.worldItemPackets.find((packet) => packet.serial === boat.serial)).toMatchObject({
      itemId: 0x31,
      dataType: 2,
    });
    expect(api.worldItemPackets.find((packet) => packet.serial === cannon.serial)).toMatchObject({
      itemId: cannon.itemId,
      dataType: 0,
    });
  });

  it('routes cannon splash through armor-aware boat damage', () => {
    const api = makeApi();
    const boat = placeGalleon(api, { kind: 'gargish', x: 100, y: 100, map: 1 });
    const boats = startBoatSystem(api);
    running.push(boats);

    const hits = applyNavalImpact(api.world, boats, { x: 101, y: 100, map: 1 }, 200, 2, { damageType: 'fire' });
    expect(hits).toHaveLength(1);
    expect(hits[0].after.hp).toBeLessThan(hits[0].before.hp);
    expect(boat.boat.lastDamage.damageType).toBe('fire');
  });
});
