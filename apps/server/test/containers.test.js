// Container flow: open (0x06 -> 0x24 + 0x3C), drop into container (0x08
// with container!=0xFFFFFFFF -> 0x25), pickup back out of container.

import { describe, it, expect, beforeEach } from 'vitest';
import { PacketWriter } from '@uo/protocol';

import { buildHandlers } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { registerItemScript, unregisterItemScript } from '../src/world/item-scripts.js';

function fakeState(world, mobile) {
  const sent = [];
  const messages = [];
  return {
    stage: Stage.InWorld,
    mobile,
    heldItem: null,
    openContainers: new Set(),
    id: 1,
    ctx: { world, config: { logPackets: false }, commands: null, handlers: null },
    accountName: 'tester',
    send(bytes) { sent.push(bytes); },
    sendSystemMessage(message) { messages.push(message); },
    sentPackets: sent,
    messages,
  };
}

const useReq = (serial) => {
  const w = new PacketWriter(5);
  w.writeU8(0x06);
  w.writeU32(serial);
  return w.bytes();
};
const pickup = (serial) => {
  const w = new PacketWriter(7);
  w.writeU8(0x07); w.writeU32(serial); w.writeU16(1);
  return w.bytes();
};
const drop = (serial, x, y, z, container) => {
  const w = new PacketWriter(14);
  w.writeU8(0x08);
  w.writeU32(serial);
  w.writeU16(x); w.writeU16(y); w.writeI8(z);
  w.writeU8(0); w.writeU32(container);
  return w.bytes();
};

describe('container flow', () => {
  /** @type {World} */ let world;
  /** @type {ReturnType<typeof fakeState>} */ let state;
  /** @type {ReturnType<typeof createItem>} */ let bag;
  /** @type {ReturnType<typeof createItem>} */ let torch;

  beforeEach(() => {
    world = new World();
    const mob = world.createMobile({ x: 100, y: 100, z: 0, map: 1 });
    state = fakeState(world, mob);
    bag = createItem(world, {
      itemId: 0x0E75, gumpId: 0x003C,
      x: 100, y: 100, z: 0, map: 1,
    });
    torch = createItem(world, { itemId: 0x0A25, x: 101, y: 100, z: 0, map: 1 });
  });

  it('opens a container on double-click', () => {
    const handlers = buildHandlers();
    handlers[0x06](state, useReq(bag.serial));
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x24);
    expect(codes).toContain(0x3C);
    expect(state.openContainers.has(bag.serial)).toBe(true);
  });

  it('runs container item scripts before generic gump open', () => {
    registerItemScript({
      name: '__test-container-onuse',
      onUse(_world, item) {
        item.scriptTouched = true;
        return true;
      },
    });
    try {
      bag.script = '__test-container-onuse';
      const handlers = buildHandlers();
      handlers[0x06](state, useReq(bag.serial));
      const codes = state.sentPackets.map((p) => p[0]);
      expect(bag.scriptTouched).toBe(true);
      expect(codes).not.toContain(0x24);
      expect(state.openContainers.has(bag.serial)).toBe(false);
    } finally {
      unregisterItemScript('__test-container-onuse');
    }
  });

  it('springs a magic trap instead of silently opening the container', () => {
    bag._magicTrapDmg = 12;
    bag._magicTrapBy = 0;
    bag.trapped = { kind: 'magic', damage: 12, level: 1, difficulty: 60 };
    state.mobile.hp = 50;
    state.mobile.hpMax = 50;

    const handlers = buildHandlers();
    handlers[0x06](state, useReq(bag.serial));

    expect(state.mobile.hp).toBe(38);
    expect(bag._magicTrapDmg).toBe(0);
    expect(bag.trapped).toBeUndefined();
    expect(state.messages).toContain('The magical trap explodes!');
    expect(state.openContainers.has(bag.serial)).toBe(false);
  });

  it('drops a held item into an open container and emits 0x25', () => {
    const handlers = buildHandlers();
    handlers[0x07](state, pickup(torch.serial));
    handlers[0x06](state, useReq(bag.serial));
    state.sentPackets.length = 0;
    handlers[0x08](state, drop(torch.serial, 42, 73, 0, bag.serial));
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x29); // dropAck
    expect(codes).toContain(0x25); // ContainerContentUpdate
    expect(torch.parent).toBe(bag.serial);
    expect(torch.gridX).toBe(42);
    expect(torch.gridY).toBe(73);
  });

  it('picks a nested item back out of an open container', () => {
    const nested = createItem(world, {
      itemId: 0x09D0, parent: bag.serial, x: 0, y: 0, z: 0, map: 0,
      gridX: 10, gridY: 10,
    });
    const handlers = buildHandlers();
    handlers[0x06](state, useReq(bag.serial));
    state.sentPackets.length = 0;
    handlers[0x07](state, pickup(nested.serial));
    expect(state.heldItem).toBe(nested);
    expect(nested.parent).toBe(state.mobile.serial);
  });

  it('refuses to pick items from containers that are not open', () => {
    const nested = createItem(world, {
      itemId: 0x09D0, parent: bag.serial, x: 0, y: 0, z: 0, map: 0,
    });
    const handlers = buildHandlers();
    handlers[0x07](state, pickup(nested.serial));
    expect(state.heldItem).toBeNull();
    const codes = state.sentPackets.map((p) => p[0]);
    expect(codes).toContain(0x27); // bounce
  });
});
