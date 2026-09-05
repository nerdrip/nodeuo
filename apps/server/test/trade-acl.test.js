// PHASE CJ — bugfix #52: handleTradeCommand must reject commands from
// strangers. Before this fix anyone who knew (or guessed) a trade
// container serial could send a `close` 0x6F and cancel an active
// trade between two other players.

import { describe, it, expect, beforeEach } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import { buildHandlers, trade } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { World } from '../src/world/world.js';

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

function tradeClosePacket(containerSerial) {
  // 0x6F layout: u8 op, u16 len, u8 kind=1 (close), u32 serial, u32 type=0,
  // u32 first=0, u32 second=0, u32 nameLen=0
  const w = new PacketWriter(17);
  w.writeU8(0x6F);
  w.writeU16(17);
  w.writeU8(0x01);
  w.writeU32(containerSerial);
  w.writeU32(0); w.writeU32(0); w.writeU32(0);
  return w.bytes();
}

describe('trade ACL (PHASE CJ bugfix #52)', () => {
  /** @type {World} */ let world;
  /** @type {ReturnType<typeof buildHandlers>} */ let handlers;
  let alice, bob, eve, session;

  beforeEach(() => {
    world = new World();
    const aliceMob = world.createMobile({ name: 'Alice', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const bobMob   = world.createMobile({ name: 'Bob',   body: 0x190, x: 1, y: 0, z: 0, map: 1 });
    const eveMob   = world.createMobile({ name: 'Eve',   body: 0x190, x: 99, y: 99, z: 0, map: 1 });
    alice = fakeState(world, aliceMob, 'a');
    bob   = fakeState(world, bobMob,   'b');
    eve   = fakeState(world, eveMob,   'e');
    aliceMob.client = alice;
    bobMob.client = bob;
    eveMob.client = eve;
    handlers = buildHandlers();
    session = trade.open(alice, bob);
    expect(session).toBeTruthy();
  });

  it('rejects close from a stranger — session stays alive', () => {
    const closePkt = tradeClosePacket(session.containerA);
    handlers[0x6F](eve, closePkt);
    // Session is still active — the registered container map keeps
    // both serials.
    expect(alice.openContainers.has(session.containerA)).toBe(true);
    expect(bob.openContainers.has(session.containerB)).toBe(true);
  });

  it('a participant CAN close their own trade', () => {
    const closePkt = tradeClosePacket(session.containerA);
    handlers[0x6F](alice, closePkt);
    expect(alice.openContainers.has(session.containerA)).toBe(false);
    expect(bob.openContainers.has(session.containerA)).toBe(false);
  });

  it('the other participant can also close', () => {
    const closePkt = tradeClosePacket(session.containerA);
    handlers[0x6F](bob, closePkt);
    expect(alice.openContainers.has(session.containerA)).toBe(false);
  });

  it('stranger cannot mark accept either', () => {
    const w = new PacketWriter(17);
    w.writeU8(0x6F);
    w.writeU16(17);
    w.writeU8(0x02);          // check
    w.writeU32(session.containerA);
    w.writeU32(0);
    w.writeU32(1);            // first = true
    w.writeU32(0);
    handlers[0x6F](eve, w.bytes());
    expect(session.acceptedA).toBe(false);
    expect(session.acceptedB).toBe(false);
  });
});
