// Trade drag-and-drop test — covers dropping an item into a trade container,
// partner visibility, accept-flag reset, and commit transferring items
// into the partner's inventory.

import { describe, it, expect, beforeEach } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers, trade } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';

function fakeState(world, mobile, id) {
  const sent = [];
  return {
    id, stage: Stage.InWorld, mobile,
    heldItem: null,
    openContainers: new Set(),
    ctx: { world, config: { logPackets: false } },
    send(b) { sent.push(b); },
    sendSystemMessage(_msg) {},
    sentPackets: sent,
  };
}

function dropPacket(serial, x, y, z, container) {
  const w = new PacketWriter(14);
  w.writeU8(0x08);
  w.writeU32(serial);
  w.writeU16(x);
  w.writeU16(y);
  w.writeI8(z);
  w.writeU8(0);
  w.writeU32(container);
  return w.bytes();
}

function pickupPacket(serial, amount = 1) {
  const w = new PacketWriter(7);
  w.writeU8(0x07);
  w.writeU32(serial);
  w.writeU16(amount);
  return w.bytes();
}

describe('trade drag-and-drop', () => {
  /** @type {World} */ let world;
  /** @type {ReturnType<typeof buildHandlers>} */ let handlers;
  let a, b, session, apple;

  beforeEach(() => {
    world = new World();
    handlers = buildHandlers();
    const mobA = world.createMobile({ name: 'Alice', x: 100, y: 100, z: 0, map: 1 });
    const mobB = world.createMobile({ name: 'Bob',   x: 101, y: 100, z: 0, map: 1 });
    a = fakeState(world, mobA, 1);
    b = fakeState(world, mobB, 2);
    session = trade.open(a, b);
    // Alice has an apple in her backpack (parent = her mobile serial).
    apple = createItem(world, {
      itemId: 0x09D0, x: 0, y: 0, z: 0, map: 0, parent: mobA.serial, movable: true,
    });
    // Pre-pickup the apple.
    a.heldItem = apple;
    apple.parent = mobA.serial; // still in inventory — handlePickUp would set this
  });

  it('drops an item into the trade container, notifies both sides, resets accept', () => {
    session.acceptedA = true;
    session.acceptedB = true;
    handlers[0x08](a, dropPacket(apple.serial, 20, 30, 0, session.containerA));
    expect(apple.parent).toBe(session.containerA);
    expect(session.itemsA.has(apple.serial)).toBe(true);
    expect(session.acceptedA).toBe(false);
    expect(session.acceptedB).toBe(false);
    // Alice: dropAck + 0x25 + tradeCheck reset
    const aHasUpdate = a.sentPackets.some((p) => p[0] === 0x25);
    const bHasUpdate = b.sentPackets.some((p) => p[0] === 0x25);
    expect(aHasUpdate).toBe(true);
    expect(bHasUpdate).toBe(true);
  });

  it('rejects Alice dropping into Bob\'s side', () => {
    handlers[0x08](a, dropPacket(apple.serial, 20, 30, 0, session.containerB));
    expect(apple.parent).toBe(null); // bounced to feet
    expect(session.itemsA.has(apple.serial)).toBe(false);
    expect(session.itemsB.has(apple.serial)).toBe(false);
  });

  it('returns an account-bound item to Alice instead of exposing it in trade', () => {
    const pack = createItem(world, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1,
      parent: a.mobile.serial, layer: 21, gumpId: 0x003C,
    });
    apple.accountBound = true;
    apple.boundAccount = 'alice';
    handlers[0x08](a, dropPacket(apple.serial, 20, 30, 0, session.containerA));
    expect(apple.parent).toBe(pack.serial);
    expect(a.heldItem).toBeNull();
    expect(session.itemsA.has(apple.serial)).toBe(false);
  });

  it('commit transfers Alice\'s items into Bob\'s inventory', () => {
    handlers[0x08](a, dropPacket(apple.serial, 10, 10, 0, session.containerA));
    expect(session.itemsA.has(apple.serial)).toBe(true);
    trade.commit(session);
    expect(apple.parent).toBe(b.mobile.serial);
    expect(session.itemsA.size).toBe(0);
  });

  it('cancel returns Alice\'s items back to her', () => {
    handlers[0x08](a, dropPacket(apple.serial, 10, 10, 0, session.containerA));
    trade.cancel(session);
    expect(apple.parent).toBe(a.mobile.serial);
  });

  it('picking an item back out of the trade container resets accept', () => {
    handlers[0x08](a, dropPacket(apple.serial, 10, 10, 0, session.containerA));
    session.acceptedA = true;
    session.acceptedB = true;
    // Now Alice picks it back.
    handlers[0x07](a, pickupPacket(apple.serial));
    expect(session.itemsA.has(apple.serial)).toBe(false);
    expect(session.acceptedA).toBe(false);
    expect(session.acceptedB).toBe(false);
    expect(a.heldItem).toBe(apple);
  });
});
