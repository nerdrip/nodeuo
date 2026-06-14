// Unit test for the pickup/drop (0x07 / 0x08) handlers.
//
// We don't spin up a WebSocket for this — instead we construct a fake
// NetState-like object with just the fields handlers use and invoke them
// synchronously with hand-built packets.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PacketWriter,
  frameIncoming,
} from '@uo/protocol';

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
    send(bytes) { sent.push(bytes); },
    sentPackets: sent,
  };
}

function pickupPacket(serial, amount = 1) {
  const w = new PacketWriter(7);
  w.writeU8(0x07);
  w.writeU32(serial);
  w.writeU16(amount);
  return w.bytes();
}

function dropPacket(serial, x, y, z, container = 0xFFFFFFFF) {
  const w = new PacketWriter(14);
  w.writeU8(0x08);
  w.writeU32(serial);
  w.writeU16(x);
  w.writeU16(y);
  w.writeI8(z);
  w.writeU8(0);           // grid location
  w.writeU32(container);  // 0xFFFFFFFF = ground
  return w.bytes();
}

function dropPacketOld(serial, x, y, z, container = 0xFFFFFFFF) {
  const w = new PacketWriter(14);
  w.writeU8(0x08);
  w.writeU32(serial);
  w.writeU16(x);
  w.writeU16(y);
  w.writeI8(z);
  w.writeU32(container);  // no grid location before 6.0.1.7
  return w.bytes();
}

describe('pickup/drop handlers', () => {
  /** @type {World} */ let world;
  /** @type {ReturnType<typeof fakeState>} */ let state;
  /** @type {ReturnType<typeof createItem>} */ let torch;

  beforeEach(() => {
    world = new World();
    const mob = world.createMobile({ x: 100, y: 100, z: 0, map: 1 });
    state = fakeState(world, mob);
    torch = createItem(world, { itemId: 0x0a0f, x: 101, y: 100, z: 0, map: 1 });
  });

  it('picks up an adjacent ground item', () => {
    const handlers = buildHandlers();
    handlers[0x07](state, pickupPacket(torch.serial));
    expect(state.heldItem).toBe(torch);
    expect(torch.parent).toBe(state.mobile.serial);
    // Sent at least a RemoveEntity (0x1D) packet.
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x1D);
  });

  it('bounces when out of range', () => {
    torch.x = 200; torch.y = 100;
    const handlers = buildHandlers();
    handlers[0x07](state, pickupPacket(torch.serial));
    expect(state.heldItem).toBeNull();
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x27); // bounce
    expect(torch.parent).toBeFalsy();
  });

  it('drops the held item to the ground and broadcasts 0xF3', () => {
    const handlers = buildHandlers();
    handlers[0x07](state, pickupPacket(torch.serial));
    state.sentPackets.length = 0;
    handlers[0x08](state, dropPacket(torch.serial, 105, 105, 5));
    expect(state.heldItem).toBeNull();
    expect(torch.x).toBe(105);
    expect(torch.y).toBe(105);
    expect(torch.z).toBe(5);
    expect(torch.parent).toBeNull();
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x29); // dropAck
    expect(codes).toContain(0xF3); // worldItemSA
  });

  it('accepts legacy 14-byte DropReq without gridLocation', () => {
    const handlers = buildHandlers();
    handlers[0x07](state, pickupPacket(torch.serial));
    state.sentPackets.length = 0;
    handlers[0x08](state, dropPacketOld(torch.serial, 106, 106, 6));
    expect(state.heldItem).toBeNull();
    expect(torch.x).toBe(106);
    expect(torch.y).toBe(106);
    expect(torch.z).toBe(6);
    expect(torch.parent).toBeNull();
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x29);
    expect(codes).toContain(0xF3);
  });

  it('rejects pickup of an already-held item', () => {
    const handlers = buildHandlers();
    handlers[0x07](state, pickupPacket(torch.serial));
    state.sentPackets.length = 0;
    handlers[0x07](state, pickupPacket(torch.serial));
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x27); // bounce
  });

  it('lifts an item equipped on the player (paperdoll → cursor)', () => {
    // Synthesise a piece of clothing already worn by the player.
    const shirt = createItem(world, {
      itemId: 0x1517, x: 0, y: 0, z: 0, map: 0,
      parent: state.mobile.serial,
      layer: 5,
      movable: true,
    });
    const handlers = buildHandlers();
    handlers[0x07](state, pickupPacket(shirt.serial));
    // Before the fix this case bounced (parent != null and not in
    // openContainers). After the fix the held slot points at the shirt and
    // its layer is cleared so the paperdoll/in-world overlay drops it.
    expect(state.heldItem).toBe(shirt);
    expect(shirt.layer).toBe(0);
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x1D);
    expect(codes).not.toContain(0x27);
  });
});

// silence unused import warning
void frameIncoming;
