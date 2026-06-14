import { describe, it, expect, afterEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem, destroyItem } from '../src/world/items.js';
import { placeCannon } from '../src/systems/cannons.js';
import { placeGalleon, startBoatSystem } from '../src/systems/boats.js';

const running = [];

afterEach(() => {
  while (running.length) running.pop().stop();
});

function makeApi() {
  const world = new World();
  return {
    world,
    items: { createItem, destroyItem },
    systems: { cannons: { placeCannon } },
    isWaterAt: () => true,
    protocol: {
      worldItemSA: () => new Uint8Array([0xF3]),
      mobileMoving: () => new Uint8Array([0x77]),
      unicodeMessage: () => new Uint8Array([0xAE]),
    },
  };
}

describe('boat system parity', () => {
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

  it('dry-docking removes hull attachments and returns a named deed', () => {
    const api = makeApi();
    const owner = api.world.createMobile({ x: 300, y: 300, z: 0, map: 1 });
    owner._packSerial = 0x4000_1234;
    const boat = placeGalleon(api, {
      kind: 'gargish',
      x: 300,
      y: 300,
      z: 0,
      map: 1,
      ownerSerial: owner.serial,
      name: 'Glass Wake',
    });
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
    const deed = api.world.items.get(r.deedSerial);
    expect(deed.script).toBe('servuo-boat-deed');
    expect(deed.parent).toBe(owner._packSerial);
    expect(deed.boatDeed).toMatchObject({
      hullKind: 'gargish',
      name: 'Glass Wake',
      ownerSerial: owner.serial,
    });
  });

  it('pilot rights accept owners and carried key items, including nested keys', () => {
    const api = makeApi();
    const owner = api.world.createMobile({ x: 1, y: 1, map: 1 });
    const crew = api.world.createMobile({ x: 1, y: 1, map: 1 });
    const boat = placeGalleon(api, {
      kind: 'galleon',
      x: 1,
      y: 1,
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
});
