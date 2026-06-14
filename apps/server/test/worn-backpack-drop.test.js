// Repro for the user-reported bug: dropping into a worn backpack that has
// never been explicitly opened (no 0x06 useReq → no entry in openContainers)
// should still succeed. The pinned-backpack UI in apps/client lets the user
// drop straight onto the docked window.

import { describe, it, expect, beforeEach } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';

function fakeState(world, mobile) {
  const sent = [];
  return {
    stage: Stage.InWorld,
    mobile,
    heldItem: null,
    openContainers: new Set(),
    id: 1,
    ctx: { world, config: { logPackets: false }, commands: null, handlers: null },
    accountName: 'tester',
    send(b) { sent.push(b); },
    sendSystemMessage() {},
    sentPackets: sent,
  };
}

const pickup = (s, amount = 1) => {
  const w = new PacketWriter(7); w.writeU8(0x07); w.writeU32(s); w.writeU16(amount);
  return w.bytes();
};
const drop = (s, x, y, z, c = 0xFFFFFFFF) => {
  const w = new PacketWriter(14);
  w.writeU8(0x08); w.writeU32(s); w.writeU16(x); w.writeU16(y);
  w.writeI8(z); w.writeU8(0); w.writeU32(c);
  return w.bytes();
};

describe('worn backpack drop without explicit open', () => {
  let world, state, bag, torch;

  beforeEach(() => {
    world = new World();
    const mob = world.createMobile({ x: 100, y: 100, z: 0, map: 1 });
    state = fakeState(world, mob);
    bag = createItem(world, {
      itemId: 0x0E75, gumpId: 0x003C,
      parent: mob.serial, layer: 21,
      x: 100, y: 100, z: 0, map: 1,
    });
    torch = createItem(world, { itemId: 0x0A25, x: 101, y: 100, z: 0, map: 1 });
  });

  it('floor → worn backpack succeeds even if backpack was never opened', () => {
    const handlers = buildHandlers();
    handlers[0x07](state, pickup(torch.serial));
    expect(state.heldItem).toBe(torch);
    handlers[0x08](state, drop(torch.serial, 30, 30, 0, bag.serial));
    expect(torch.parent).toBe(bag.serial);
    expect(state.heldItem).toBeNull();
  });

  it('worn backpack item → ground succeeds', () => {
    const item = createItem(world, {
      itemId: 0x09D0, parent: bag.serial, gridX: 10, gridY: 10,
      x: 0, y: 0, z: 0, map: 0,
    });
    const handlers = buildHandlers();
    handlers[0x07](state, pickup(item.serial));
    expect(state.heldItem).toBe(item);
    handlers[0x08](state, drop(item.serial, 105, 105, 5));
    expect(item.parent).toBeNull();
    expect(item.x).toBe(105);
  });

  it('splits a stack on partial lift and merges it back on drop', () => {
    const gold = createItem(world, {
      itemId: 0x0EED, parent: bag.serial, amount: 100,
      gridX: 20, gridY: 30, x: 0, y: 0, z: 0, map: 0,
    });
    const handlers = buildHandlers();
    handlers[0x07](state, pickup(gold.serial, 25));
    expect(state.heldItem).toBe(gold);
    expect(gold.amount).toBe(25);
    const remainders = [...world.items.values()].filter((it) => (
      it.serial !== gold.serial && it.parent === bag.serial && it.itemId === 0x0EED
    ));
    expect(remainders).toHaveLength(1);
    expect(remainders[0].amount).toBe(75);
    expect(state.sentPackets.some((p) => p[0] === 0x25)).toBe(true);

    handlers[0x08](state, drop(gold.serial, 20, 30, 0, bag.serial));
    expect(world.items.has(gold.serial)).toBe(false);
    expect(remainders[0].amount).toBe(100);
    expect(state.heldItem).toBeNull();
  });

  it('worn shirt → worn backpack succeeds (paperdoll → backpack)', () => {
    const shirt = createItem(world, {
      itemId: 0x1517, parent: state.mobile.serial, layer: 5,
      x: 0, y: 0, z: 0, map: 0,
    });
    const handlers = buildHandlers();
    handlers[0x07](state, pickup(shirt.serial));
    expect(state.heldItem).toBe(shirt);
    expect(shirt.layer).toBe(0);
    handlers[0x08](state, drop(shirt.serial, 5, 5, 0, bag.serial));
    expect(shirt.parent).toBe(bag.serial);
  });
});
