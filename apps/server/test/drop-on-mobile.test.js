// Drop-on-mobile tests (PHASE item system 2026-05-05).
//
// Covers the new 0x08 branch: dropping a held item directly onto a mobile
// (player → auto-open trade, NPC → registered hook or refuse).

import { describe, it, expect, beforeEach } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers, mobileDragDrop } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';

function fakeState(world, mobile, id) {
  const sent = [];
  const state = {
    id, stage: Stage.InWorld, mobile,
    heldItem: null,
    openContainers: new Set(),
    ctx: { world, config: { logPackets: false } },
    send(b) { sent.push(b); },
    sendSystemMessage(_msg) {},
    sentPackets: sent,
  };
  // Mark this state as the mobile's client so handleDrop's drop-on-player
  // branch sees a connected player on the other side.
  mobile.client = state;
  return state;
}

function dropPacket(serial, x, y, z, container) {
  const w = new PacketWriter(15);
  w.writeU8(0x08);
  w.writeU32(serial);
  w.writeU16(x); w.writeU16(y);
  w.writeI8(z);
  w.writeU8(0);   // gridLocation
  w.writeU32(container);
  return w.bytes();
}

describe('drop-on-mobile', () => {
  /** @type {World} */ let world;
  /** @type {ReturnType<typeof buildHandlers>} */ let handlers;
  let alice, bob, npc, alState, bobState, item;

  beforeEach(() => {
    world = new World();
    handlers = buildHandlers();
    alice = world.createMobile({ name: 'Alice', x: 100, y: 100, z: 0, map: 1 });
    bob   = world.createMobile({ name: 'Bob',   x: 101, y: 100, z: 0, map: 1 });
    npc   = world.createMobile({ name: 'Vendor', x: 100, y: 101, z: 0, map: 1 });
    alState = fakeState(world, alice, 1);
    bobState = fakeState(world, bob,  2);
    // NPC has no .client — clear the assignment fakeState made.
    npc.client = undefined;
    item = createItem(world, {
      itemId: 0x09D0, x: 0, y: 0, z: 0, map: 0, parent: alice.serial, movable: true,
    });
    alState.heldItem = item;
  });

  it('drop-on-self bounces with reason 0x01 and clears held', () => {
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, alice.serial));
    // 0x29 false ack + 0x27 bounce
    expect(alState.sentPackets.some((p) => p[0] === 0x27)).toBe(true);
    expect(alState.heldItem).toBe(null);
    // Item back on the ground at Alice's feet (parent=null).
    expect(item.parent).toBe(null);
  });

  it('drop-on-other-player auto-opens a trade session and stages the item', () => {
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, bob.serial));
    // Both sides should have received tradeOpen (0x6F) + displayContainer
    // (0x24) + containerContents (0x3C) packets from trade.open(), plus
    // a 0x25 update for the staged item from handleTradeDrop.
    expect(alState.sentPackets.some((p) => p[0] === 0x6F)).toBe(true);
    expect(bobState.sentPackets.some((p) => p[0] === 0x6F)).toBe(true);
    expect(alState.sentPackets.some((p) => p[0] === 0x25)).toBe(true);
    expect(bobState.sentPackets.some((p) => p[0] === 0x25)).toBe(true);
    expect(alState.heldItem).toBe(null);
    // Item lives in Alice's trade container; serial != alice.serial,
    // != bob.serial — it's the virtual containerA we just opened.
    expect(item.parent).not.toBe(alice.serial);
    expect(item.parent).not.toBe(bob.serial);
  });

  it('second drop reuses the existing trade session (no duplicate open)', () => {
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, bob.serial));
    const firstParent = item.parent;
    // Pick the item out of the trade container (re-arms held).
    alState.heldItem = item;
    item.parent = alice.serial;
    // Drop on Bob a second time — should land in the SAME trade container,
    // not open a new one.
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, bob.serial));
    expect(item.parent).toBe(firstParent);
    // Only one tradeOpen (0x6F initial pair) per side from the first drop.
    const tradeOpens = alState.sentPackets.filter((p) => p[0] === 0x6F).length;
    expect(tradeOpens).toBe(1);
  });

  it('drop-on-NPC without a hook bounces with system message', () => {
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, npc.serial));
    expect(alState.heldItem).toBe(null);
    expect(item.parent).toBe(null); // bounced to feet
    // No registered hook → handleDrop falls through to refuse path.
  });

  it('drop-on-NPC with a hook returning true consumes the item', () => {
    let hookSawItem = null;
    mobileDragDrop.register(npc.serial, (s, m, it) => {
      hookSawItem = it;
      // Pretend the NPC consumed the offering.
      return true;
    });
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, npc.serial));
    expect(hookSawItem).toBe(item);
    expect(alState.heldItem).toBe(null);
    // dropAck(true) was sent (0x29 with ok byte).
    expect(alState.sentPackets.some((p) => p[0] === 0x29 && p[1] === 0x00)).toBe(true);
    mobileDragDrop.unregister(npc.serial);
  });

  it('drop-on-NPC with a hook returning false bounces normally', () => {
    mobileDragDrop.register(npc.serial, () => false);
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, npc.serial));
    expect(alState.heldItem).toBe(null);
    expect(item.parent).toBe(null); // refused → bounce
    mobileDragDrop.unregister(npc.serial);
  });

  it('drop on an out-of-range mobile bounces', () => {
    bob.x = 200; bob.y = 200; // 100 tiles away
    handlers[0x08](alState, dropPacket(item.serial, 0, 0, 0, bob.serial));
    expect(alState.heldItem).toBe(null);
    expect(item.parent).toBe(null);
    expect(alState.sentPackets.some((p) => p[0] === 0x27)).toBe(true);
  });
});
