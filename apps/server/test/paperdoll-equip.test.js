import { describe, expect, it } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { registerTemplate, unregisterTemplate } from '../src/world/templates.js';

function packet(op, serial, extra = 1, mobile = 0) {
  if (op === 0x07) {
    const w = new PacketWriter(7);
    w.writeU8(op); w.writeU32(serial); w.writeU16(extra);
    return w.bytes();
  }
  const w = new PacketWriter(10);
  w.writeU8(0x13); w.writeU32(serial); w.writeU8(extra); w.writeU32(mobile);
  return w.bytes();
}

function unequipPacket(...layers) {
  const w = new PacketWriter(4 + layers.length);
  w.writeU8(0xED); w.writeU16(4 + layers.length); w.writeU8(layers.length);
  for (const layer of layers) w.writeU8(layer);
  return w.bytes();
}

function fixture() {
  const world = new World();
  const mobile = world.createMobile({ x: 100, y: 100, z: 0, map: 1, str: 50, dex: 50, int: 50 });
  const sent = [];
  const state = {
    stage: Stage.InWorld, mobile, heldItem: null, openContainers: new Set(),
    accountName: 'equip-test', account: { accessLevel: 'Player' },
    ctx: { world, config: { logPackets: false }, commands: null, handlers: null },
    send(bytes) { sent.push(bytes); }, sendSystemMessage() {}, sentPackets: sent,
  };
  mobile.client = state;
  const bag = createItem(world, {
    itemId: 0x0E75, gumpId: 0x003C, parent: mobile.serial, layer: 21,
    x: 0, y: 0, z: 0, map: 1,
  });
  return { world, mobile, state, bag, handlers: buildHandlers() };
}

describe('paperdoll drag/equip round-trip', () => {
  it('atomically swaps an occupied layer and pushes the old item into the backpack', () => {
    const { world, mobile, state, bag, handlers } = fixture();
    const oldShirt = createItem(world, { itemId: 0x1517, parent: mobile.serial, layer: 5, map: 1 });
    const newShirt = createItem(world, { itemId: 0x1517, parent: bag.serial, layer: 0, map: 1 });

    handlers[0x07](state, packet(0x07, newShirt.serial));
    handlers[0x13](state, packet(0x13, newShirt.serial, 5, mobile.serial));

    expect(state.heldItem).toBeNull();
    expect(newShirt).toMatchObject({ parent: mobile.serial, layer: 5 });
    expect(oldShirt).toMatchObject({ parent: bag.serial, layer: 0 });
    expect(state.sentPackets.map((p) => p[0])).toContain(0x25);
    expect(state.sentPackets.map((p) => p[0])).toContain(0x2E);
  });

  it('returns a rejected item visibly to the backpack instead of losing it', () => {
    const { mobile, state, bag, handlers, world } = fixture();
    const plate = createItem(world, {
      itemId: 0x1415, parent: bag.serial, layer: 0, strReq: 95, map: 1,
    });

    handlers[0x07](state, packet(0x07, plate.serial));
    state.sentPackets.length = 0;
    handlers[0x13](state, packet(0x13, plate.serial, 13, mobile.serial));

    expect(state.heldItem).toBeNull();
    expect(plate).toMatchObject({ parent: bag.serial, layer: 0 });
    expect(state.sentPackets.map((p) => p[0])).toContain(0x27);
    expect(state.sentPackets.map((p) => p[0])).toContain(0x25);
  });

  it('keeps a spellbook equipped when a robe packet carries a stale hand layer', () => {
    const { world, mobile, state, bag, handlers } = fixture();
    const spellbook = createItem(world, {
      itemId: 0x0EFA, parent: mobile.serial, layer: 1,
      equipLayer: 1, spellbook: true, clothing: true, map: 1,
    });
    const robe = createItem(world, {
      itemId: 0x1F03, parent: bag.serial, layer: 0,
      equipLayer: 22, clothing: true, map: 1,
    });

    handlers[0x07](state, packet(0x07, robe.serial));
    // Reproduce a client whose tiledata mistakenly calls the robe layer 1.
    handlers[0x13](state, packet(0x13, robe.serial, 1, mobile.serial));

    expect(robe).toMatchObject({ parent: mobile.serial, layer: 22 });
    expect(spellbook).toMatchObject({ parent: mobile.serial, layer: 1 });
    expect(state.heldItem).toBeNull();
  });

  it('recovers the robe layer by graphic for legacy items without equip metadata', () => {
    const { world, mobile, state, bag, handlers } = fixture();
    const templateName = 'test-legacy-gm-robe';
    registerTemplate({ name: templateName, itemId: 0x1F03, equipLayer: 22, clothing: true });
    try {
      const spellbook = createItem(world, {
        itemId: 0x0EFA, parent: mobile.serial, layer: 1,
        equipLayer: 1, spellbook: true, map: 1,
      });
      const legacyRobe = createItem(world, {
        itemId: 0x1F03, parent: bag.serial, layer: 0, map: 1,
      });

      handlers[0x07](state, packet(0x07, legacyRobe.serial));
      handlers[0x13](state, packet(0x13, legacyRobe.serial, 1, mobile.serial));

      expect(legacyRobe).toMatchObject({ parent: mobile.serial, layer: 22 });
      expect(spellbook).toMatchObject({ parent: mobile.serial, layer: 1 });
    } finally {
      unregisterTemplate(templateName);
    }
  });

  it('broadcasts macro-unequipped paperdoll removals through nearby mobile clients', () => {
    const { world, mobile, state, bag, handlers } = fixture();
    mobile.backpack = bag.serial;
    const observer = world.createMobile({ x: 101, y: 100, z: 0, map: 1 });
    const observedPackets = [];
    observer.client = { send(bytes) { observedPackets.push(bytes); } };
    const shirt = createItem(world, { itemId: 0x1517, parent: mobile.serial, layer: 5, map: 1 });

    handlers[0xED](state, unequipPacket(5));

    expect(shirt).toMatchObject({ parent: bag.serial, layer: 0 });
    expect(observedPackets.map((bytes) => bytes[0])).toContain(0x1D);
    expect(state.sentPackets.map((bytes) => bytes[0])).toContain(0x3C);
  });
});
