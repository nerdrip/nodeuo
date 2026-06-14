import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { createScriptGameApi } from '../src/script-game-api.js';
import { createWorldOpsApi } from '../src/world/ops-api.js';
import { createWorldQueryApi } from '../src/world/query-api.js';

function captureClient() {
  const sent = [];
  const system = [];
  return {
    sent,
    system,
    send(packet) { sent.push(packet); },
    sendSystemMessage(text, hue) { system.push({ text, hue }); },
  };
}

describe('script game api', () => {
  it('provides indexed inventory helpers for scripts', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const ops = createWorldOpsApi(world);
    const game = createScriptGameApi({ world, query, ops });
    const mob = world.createMobile({ name: 'owner', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, name: 'backpack' });
    const helm = createItem(world, { itemId: 0x140E, parent: mob.serial, layer: 6, name: 'helmet' });
    const pouch = createItem(world, { itemId: 0x0E79, parent: pack.serial, name: 'pouch' });
    const gold = createItem(world, { itemId: 0x0EED, parent: pouch.serial, amount: 25, name: 'gold' });

    expect(game.inventory.findBackpack(mob)).toBe(pack);
    expect([...game.inventory.childrenOf(mob)]).toEqual([pack, helm]);
    expect([...game.inventory.descendantsOf(pack)]).toEqual([pouch, gold]);
    expect([...game.inventory.equipped(mob)]).toEqual([pack, helm]);
    expect(game.inventory.findEquipped(mob, 21)).toBe(pack);
    expect(game.inventory.findEquipped(mob, (it) => it.name === 'backpack')).toBe(pack);
    expect(game.inventory.findChild(pack, (it) => it.itemId === 0x0E79)).toBe(pouch);
    expect(game.inventory.findDescendant(pack, (it) => it.itemId === 0x0EED)).toBe(gold);
    expect([...game.inventory.packItems(mob)].map((it) => it.serial)).toEqual([
      pouch.serial, gold.serial,
    ]);
    expect(game.inventory.isInPack(gold, mob)).toBe(true);
    expect(game.inventory.isInPack(helm, mob)).toBe(false);
    expect(game.inventory.findInPack(mob, (it) => it.itemId === 0x0EED)).toBe(gold);
  });

  it('creates mobiles through the script mobile API', () => {
    const world = new World();
    const game = createScriptGameApi({ world });

    const mob = game.mobile.create({
      name: 'scripted npc',
      body: 0x0190,
      x: 50, y: 60, z: 0, map: 1,
      kind: 'vendor',
    });

    expect(mob).toBeTruthy();
    expect(world.mobiles.get(mob.serial)).toBe(mob);
    expect(mob.name).toBe('scripted npc');
    expect(mob.kind).toBe('vendor');
  });

  it('provides indexed spatial helpers for gameplay scripts', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const ops = createWorldOpsApi(world);
    const game = createScriptGameApi({ world, query, ops });
    const caster = world.createMobile({ name: 'caster', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const near = world.createMobile({ name: 'near', body: 0x190, x: 12, y: 11, z: 0, map: 1 });
    const far = world.createMobile({ name: 'far', body: 0x190, x: 40, y: 40, z: 0, map: 1 });
    const otherFacet = world.createMobile({ name: 'facet', body: 0x190, x: 11, y: 10, z: 0, map: 2 });
    near.client = captureClient();
    near.name = 'Alice';
    const ground = createItem(world, { itemId: 0x0F6C, x: 11, y: 10, z: 0, map: 1 });
    ground.boat = { riders: new Set() };
    const contained = createItem(world, { itemId: 0x0EED, parent: caster.serial, x: 11, y: 10, map: 1 });

    expect([...game.mobilesNear(caster, { range: 3, self: caster })]).toEqual([near]);
    expect(game.findMobileNear(caster, (m) => m === near, { range: 3, self: caster })).toBe(near);
    expect(game.findClientNear(caster, (m) => m === near, { range: 3, self: caster })).toBe(near);
    expect([...game.mobilesAt({ x: near.x, y: near.y, map: 1 })]).toEqual([near]);
    expect([...game.itemsNear(caster, { range: 3 })]).toEqual([ground]);
    expect(game.findItemNear(caster, (it) => it.boat, { range: 3 })).toBe(ground);
    expect([...game.itemsAt({ x: ground.x, y: ground.y, map: 1 })]).toEqual([ground]);
    expect(game.mobileBySerial(near.serial)).toBe(near);
    expect(game.itemBySerial(ground.serial)).toBe(ground);
    expect(game.entityBySerial(contained.serial)).toBe(contained);
    expect(game.entityBySerial(near.serial)).toBe(near);
    expect(game.findMobile((m) => m.name === 'Alice')).toBe(near);
    expect(game.findItem((it) => it.boat)).toBe(ground);
    expect([...game.allMobiles((m) => m.map === 1)]).toEqual([caster, near, far]);
    expect([...game.allItems()]).toEqual([ground, contained]);
    expect([...game.onlineMobiles()]).toEqual([near]);
    expect(game.onlineCount()).toBe(1);
    expect(game.findOnlineByName('alice')).toBe(near);
    expect(game.sendToOnline({ type: 'online' })).toBe(1);
    expect(near.client.sent).toEqual([{ type: 'online' }]);
    expect([...game.mobilesNear(caster, 3)]).toEqual([caster, near]);
    expect([...game.mobilesNear(caster, { range: 3 })]).not.toContain(far);
    expect([...game.mobilesNear(caster, { range: 3 })]).not.toContain(otherFacet);
    expect([...game.itemsNear(caster, { range: 3 })]).not.toContain(contained);
  });

  it('teleports mobiles through one indexed broadcast/update path', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const ops = createWorldOpsApi(world);
    const moverClient = captureClient();
    const oldClient = captureClient();
    const newClient = captureClient();
    const mover = world.createMobile({
      name: 'traveler', body: 0x190, x: 10, y: 10, z: 0, map: 1,
    });
    const oldObserver = world.createMobile({
      name: 'old', body: 0x190, x: 11, y: 10, z: 0, map: 1,
    });
    const newObserver = world.createMobile({
      name: 'new', body: 0x190, x: 101, y: 100, z: 0, map: 2,
    });
    mover.client = moverClient;
    oldObserver.client = oldClient;
    newObserver.client = newClient;
    let refreshed = null;
    const protocol = {
      removeEntity: (serial) => ({ type: 'remove', serial }),
      extMapChange: (map) => ({ type: 'map', map }),
      mobileUpdate: (payload) => ({ type: 'update', ...payload }),
      mobileMoving: (payload) => ({ type: 'moving', ...payload }),
    };
    const state = { id: 'net#1' };
    const game = createScriptGameApi({
      world,
      query,
      ops,
      protocol,
      handlers: { refreshSurroundings: (s) => { refreshed = s; } },
    });

    const result = game.mobile.teleport(mover, { x: 100, y: 100, z: 5, map: 2 }, {
      state,
      refresh: true,
    });

    expect(result.mob).toBe(mover);
    expect(result.oldObservers).toEqual([oldObserver]);
    expect(result.newObservers).toEqual([newObserver]);
    expect([...query.mobilesAt({ x: 10, y: 10, map: 1 })]).toEqual([]);
    expect([...query.mobilesAt({ x: 100, y: 100, map: 2 })]).toEqual([mover]);
    expect(oldClient.sent).toEqual([{ type: 'remove', serial: mover.serial }]);
    expect(moverClient.sent.map((p) => p.type)).toEqual(['map', 'update']);
    expect(newClient.sent.map((p) => p.type)).toEqual(['moving']);
    expect(refreshed).toBe(state);
  });

  it('provides live entity handles for ergonomic scripts', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const ops = createWorldOpsApi(world);
    const client = captureClient();
    const game = createScriptGameApi({ world, query, ops });
    const mob = world.createMobile({ name: 'owner', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const other = world.createMobile({ name: 'other', body: 0x190, x: 12, y: 10, z: 0, map: 1 });
    mob.client = client;
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, name: 'backpack' });
    const pouch = createItem(world, { itemId: 0x0E79, parent: pack.serial, name: 'pouch' });
    const gold = createItem(world, { itemId: 0x0EED, parent: pouch.serial, amount: 25, name: 'gold' });
    const ground = createItem(world, { itemId: 0x0F6C, x: 11, y: 10, z: 0, map: 1, name: 'ground' });

    const mobRef = game.mobileRef(mob.serial);
    const packRef = mobRef.backpack();
    const groundRef = game.ref(ground);

    expect(mobRef).toBeInstanceOf(game.refs.MobileRef);
    expect(packRef).toBeInstanceOf(game.refs.ItemRef);
    expect(groundRef).toBeInstanceOf(game.refs.ItemRef);
    expect(game.itemRef(ground.serial).entity).toBe(ground);
    expect(game.ref(other.serial).distanceTo(mobRef)).toBe(2);
    expect(mobRef.inRange(other, 2)).toBe(true);
    expect(mobRef.sendSystemMessage('hello', 33)).toBe(true);
    expect(client.system).toEqual([{ text: 'hello', hue: 33 }]);
    expect(mobRef.packItems()).toEqual([pouch, gold]);
    expect(mobRef.findInPack((it) => it.itemId === 0x0EED)).toBe(gold);
    expect(packRef.descendants()).toEqual([pouch, gold]);
    expect(mobRef.nearbyMobiles({ range: 3, self: mob })).toEqual([other]);
    expect(groundRef.nearbyItems({ range: 1 })).toEqual([ground]);

    expect(groundRef.move({ parent: pack.serial }).parentChanged).toBe(true);
    expect(game.inventory.isContainedBy(ground, pack)).toBe(true);
    expect(groundRef.destroy()).toBe(true);
    expect(groundRef.exists).toBe(false);
    expect(game.itemRef(ground.serial)).toBe(null);
  });

  it('gives items through the mobile facade and notifies the open pack', () => {
    const world = new World();
    const query = createWorldQueryApi(world);
    const ops = createWorldOpsApi(world);
    const client = captureClient();
    const protocol = {
      containerContentUpdate: (item, containerSerial) => ({
        type: 'container-update',
        serial: item.serial,
        containerSerial,
        gridX: item.gridX,
        gridY: item.gridY,
      }),
    };
    const game = createScriptGameApi({ world, query, ops, protocol });
    const mob = world.createMobile({ name: 'owner', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    mob.client = client;
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, name: 'backpack' });

    const reward = game.mobile.giveItem(mob, {
      itemId: 0x0EED,
      amount: 100,
      name: 'gold',
    }, { randomGrid: true });

    expect(reward.parent).toBe(pack.serial);
    expect(reward.map).toBe(1);
    expect(reward.x).toBeGreaterThanOrEqual(60);
    expect(reward.x).toBeLessThan(140);
    expect(reward.y).toBeGreaterThanOrEqual(60);
    expect(reward.y).toBeLessThan(120);
    expect(reward.gridX).toBe(reward.x);
    expect(reward.gridY).toBe(reward.y);
    expect(client.sent).toEqual([{
      type: 'container-update',
      serial: reward.serial,
      containerSerial: pack.serial,
      gridX: reward.gridX,
      gridY: reward.gridY,
    }]);
    expect(game.mobileRef(mob).giveItem({ itemId: 0x0F0E, name: 'gem' }).parent).toBe(pack.serial);
  });
});
