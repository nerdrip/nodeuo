import { afterEach, describe, expect, it, vi } from 'vitest';
import { PacketReader, PacketWriter } from '@uo/protocol';
import { buildHandlers, vendors } from '../src/net/handlers.js';
import { World } from '../src/world/world.js';
import { RegionRegistry } from '../src/regions.js';
import * as preventInaccess from '../src/systems/world/prevent-inaccess.js';

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

function unicodeText(packet) {
  const r = new PacketReader(packet);
  r.readU8(); r.readU16(); r.readU32(); r.readU16(); r.readU8();
  r.readU16(); r.readU16(); r.readAsciiFixed(4); r.readAsciiFixed(30);
  return r.readUnicodeNull(256);
}

function attachListener(mobile, packets, accessLevel = 'Player') {
  mobile.client = {
    account: { accessLevel },
    send(packet) { packets.push(packet); },
  };
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

  it('makes ghost speech listener-specific and lets ghosts and Spirit Speak users understand it', () => {
    const world = new World();
    const selfPackets = [];
    const livingPackets = [];
    const ghostPackets = [];
    const spiritPackets = [];
    const speaker = world.createMobile({ name: 'shade', x: 100, y: 100, z: 0, map: 1, hp: 0 });
    speaker.ghost = true;
    const living = world.createMobile({ name: 'living', x: 101, y: 100, z: 0, map: 1, hp: 50 });
    const ghost = world.createMobile({ name: 'ghost', x: 102, y: 100, z: 0, map: 1, hp: 0 });
    ghost.ghost = true;
    const spirit = world.createMobile({ name: 'medium', x: 103, y: 100, z: 0, map: 1, hp: 50 });
    spirit._spiritSpeakUntil = Date.now() + 10_000;
    attachListener(living, livingPackets);
    attachListener(ghost, ghostPackets);
    attachListener(spirit, spiritPackets);
    const state = makeState(world, speaker, selfPackets);

    buildHandlers()[0x03](state, asciiSpeech('Meet me by the old shrine.'));

    expect(unicodeText(selfPackets.find((p) => p[0] === 0xAE))).toBe('Meet me by the old shrine.');
    expect(unicodeText(ghostPackets[0])).toBe('Meet me by the old shrine.');
    expect(unicodeText(spiritPackets[0])).toBe('Meet me by the old shrine.');
    const obscured = unicodeText(livingPackets[0]);
    expect(obscured).not.toBe('Meet me by the old shrine.');
    expect(obscured.replace(/\s/g, '')).toMatch(/^[Oo]+$/);
  });

  it('does not let ghosts invoke a living vendor or keyword-driven merchant AI', () => {
    const world = new World();
    const sent = [];
    const player = world.createMobile({ name: 'shade', x: 100, y: 100, z: 0, map: 1, hp: 0 });
    player.ghost = true;
    const vendor = world.createMobile({ name: 'Jacob', x: 101, y: 100, z: 0, map: 1 });
    vendor._listensToSpeech = true;
    vendor._speechKeywords = ['buy'];
    registeredVendor = vendor.serial;
    vendors.register({ vendorSerial: vendor.serial, listStock: () => [] });
    const state = makeState(world, player, sent);

    buildHandlers()[0x03](state, asciiSpeech('buy'));

    expect(sent.some((p) => p[0] === 0x74)).toBe(false);
    expect(vendor._heardSpeech ?? []).toHaveLength(0);
  });

  it('uses classic whisper, regular and yell hearing ranges', () => {
    const world = new World();
    const player = world.createMobile({ name: 'speaker', x: 100, y: 100, z: 0, map: 1 });
    const packets = [];
    const listener = world.createMobile({ name: 'listener', x: 102, y: 100, z: 0, map: 1 });
    attachListener(listener, packets);
    const state = makeState(world, player, []);

    buildHandlers()[0x03](state, asciiSpeech('quiet', { type: 8 }));
    expect(packets).toHaveLength(0);
    buildHandlers()[0x03](state, asciiSpeech('normal', { type: 0 }));
    expect(unicodeText(packets.at(-1))).toBe('normal');
    listener.x = 117;
    world.sectors.moveMobile(listener);
    buildHandlers()[0x03](state, asciiSpeech('loud', { type: 9 }));
    expect(unicodeText(packets.at(-1))).toBe('loud');
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

  it('validates movement sequence integrity for staff accounts too', () => {
    const world = new World();
    const sent = [];
    const player = world.createMobile({ name: 'admin', x: 1000, y: 1000, z: 0, map: 1, direction: 2 });
    const state = makeState(world, player, sent);
    state.account.accessLevel = 'Admin';
    state._lastMoveSeq = 1;

    buildHandlers()[0x02](state, movementReq(0x02, 3));

    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe(0x21);
    expect(sent[0][1]).toBe(3);
    expect(state._lastMoveSeq).toBe(3);
  });

  it('allows a zero-stamina ghost to move without draining or fatigue rejection', () => {
    const world = new World();
    const sent = [];
    const ghost = world.createMobile({
      name: 'restless spirit', x: 1000, y: 1000, z: 0, map: 1,
      direction: 2, hp: 0, stam: 0, stamMax: 50,
    });
    ghost.ghost = true;
    const state = makeState(world, ghost, sent);

    buildHandlers()[0x02](state, movementReq(0x02, 1));

    expect(sent.some((p) => p[0] === 0x22)).toBe(true);
    expect(ghost.x).toBe(1001);
    expect(ghost.stam).toBe(0);
  });

  it('rejects a gated region boundary before committing the player step', () => {
    const world = new World();
    const sent = [];
    const player = world.createMobile({
      name: 'visitor', x: 1000, y: 1000, z: 0, map: 1, direction: 2,
      hp: 50, hpMax: 50, stam: 50, stamMax: 50,
    });
    const regions = new RegionRegistry();
    regions.register({
      name: '__test-restricted', map: 1,
      rects: [{ x1: 1001, y1: 1000, x2: 1001, y2: 1000 }],
    });
    preventInaccess.setGate('__test-restricted', () => ({ ok: false, reason: 'Access denied.' }));
    const state = makeState(world, player, sent);
    state.ctx.regions = regions;
    state.ctx.systems = { preventInaccess };

    buildHandlers()[0x02](state, movementReq(0x02, 1));

    expect(player.x).toBe(1000);
    expect(sent.some((packet) => packet[0] === 0x21)).toBe(true);
    expect(sent.some((packet) => packet[0] === 0x22)).toBe(false);
    preventInaccess.clearGate('__test-restricted');
  });
});
