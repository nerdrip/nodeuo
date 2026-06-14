import { afterEach, describe, expect, it, vi } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers, vendors } from '../src/net/handlers.js';
import { World } from '../src/world/world.js';

function asciiSpeech(text, { type = 0, hue = 0x03B2, font = 3 } = {}) {
  const s = String(text ?? '');
  const w = new PacketWriter(9 + s.length);
  w.writeU8(0x03);
  w.writeU16(9 + s.length);
  w.writeU8(type);
  w.writeU16(hue);
  w.writeU16(font);
  w.writeAsciiNull(s);
  return w.bytes();
}

function movementReq(direction, sequence = 1) {
  const w = new PacketWriter(7);
  w.writeU8(0x02);
  w.writeU8(direction);
  w.writeU8(sequence);
  w.writeU32(0);
  return w.bytes();
}

function makeState(world, player, sent) {
  const state = {
    stage: 'inWorld',
    mobile: player,
    account: { accessLevel: 'Player' },
    ctx: {
      world,
      config: {},
      commands: { dispatch: vi.fn(() => false) },
      events: { emit: vi.fn() },
    },
    send(bytes) { sent.push(bytes); },
    sendItem(item) { sent.push(new Uint8Array([0xF3, item.serial & 0xff])); },
    sendSystemMessage(text) { sent.push(new Uint8Array([0xAE, String(text).length & 0xff])); },
  };
  player.client = state;
  return state;
}

describe('speech and movement regressions', () => {
  let registeredVendor = 0;

  afterEach(() => {
    if (registeredVendor) vendors.unregister(registeredVendor);
    registeredVendor = 0;
  });

  it('routes legacy ASCII speech through the same NPC speech queue as Unicode', () => {
    const world = new World();
    const sent = [];
    const player = world.createMobile({ name: 'speaker', x: 100, y: 100, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'shopkeeper', x: 101, y: 100, z: 0, map: 1 });
    npc._listensToSpeech = true;
    npc._speechKeywords = ['buy'];
    const state = makeState(world, player, sent);

    buildHandlers()[0x03](state, asciiSpeech('buy'));

    expect(npc._heardSpeech).toHaveLength(1);
    expect(npc._heardSpeech[0].speaker).toBe(player);
    expect(npc._heardSpeech[0].text).toBe('buy');
    expect(state.ctx.events.emit).toHaveBeenCalledWith('speech', expect.objectContaining({ speaker: player, text: 'buy' }));
  });

  it('opens a registered vendor immediately on speech buy and avoids duplicate AI queueing', () => {
    const world = new World();
    const sent = [];
    const player = world.createMobile({ name: 'buyer', x: 100, y: 100, z: 0, map: 1 });
    const vendor = world.createMobile({ name: 'Jacob', x: 101, y: 100, z: 0, map: 1 });
    vendor._listensToSpeech = true;
    vendor._speechKeywords = ['buy', 'sell', 'shop'];
    registeredVendor = vendor.serial;
    vendors.register({
      vendorSerial: vendor.serial,
      listStock: () => [{
        serial: 0x70000001,
        itemId: 0x0EED,
        hue: 0,
        amount: 1,
        price: 5,
        description: 'gold coin',
      }],
    });
    const state = makeState(world, player, sent);

    buildHandlers()[0x03](state, asciiSpeech('vendor buy'));

    expect(sent.some((p) => p[0] === 0x74)).toBe(true);
    expect(vendor._heardSpeech ?? []).toHaveLength(0);
  });

  it('sends movement ack before sector visibility streaming', () => {
    const world = new World();
    const sent = [];
    const player = world.createMobile({ name: 'walker', x: 999, y: 1000, z: 0, map: 1, direction: 2 });
    world.items.set(0x40000001, {
      serial: 0x40000001,
      itemId: 0x0EED,
      amount: 1,
      hue: 0,
      x: 1000,
      y: 1000,
      z: 0,
      map: 1,
      parent: null,
    });
    const state = makeState(world, player, sent);

    buildHandlers()[0x02](state, movementReq(0x02, 1));

    const ackIndex = sent.findIndex((p) => p[0] === 0x22);
    const itemIndex = sent.findIndex((p) => p[0] === 0xF3);
    expect(ackIndex).toBeGreaterThanOrEqual(0);
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(itemIndex);
  });
});
