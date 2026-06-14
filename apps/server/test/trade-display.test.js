// FAZA CO — bugfix #57: trade.open must send 0x24 displayContainer +
// 0x3C containerContents for both trade containers to both participants
// so the existing container-ui can visualise items going through the
// trade. Without this, items reparented by handleTradeDrop showed only
// in server bookkeeping — clients never tracked the windows so the
// 0x25 update arrived at a no-op handler.

import { describe, it, expect, beforeEach } from 'vitest';
import { trade } from '../src/net/handlers.js';
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

describe('trade.open displays both containers (bugfix #57)', () => {
  /** @type {World} */ let world;
  let alice, bob, session;

  beforeEach(() => {
    world = new World();
    const aliceMob = world.createMobile({ name: 'Alice', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const bobMob   = world.createMobile({ name: 'Bob',   body: 0x190, x: 1, y: 0, z: 0, map: 1 });
    alice = fakeState(world, aliceMob, 'a');
    bob   = fakeState(world, bobMob,   'b');
    aliceMob.client = alice;
    bobMob.client = bob;
    session = trade.open(alice, bob);
    expect(session).toBeTruthy();
  });

  it('both participants receive 0x24 displayContainer for both trade containers', () => {
    const aliceDisplays = alice.sentPackets.filter((b) => b[0] === 0x24);
    const bobDisplays   = bob.sentPackets.filter((b) => b[0] === 0x24);
    // 2 containers each side → 2 displayContainer packets per side.
    expect(aliceDisplays.length).toBeGreaterThanOrEqual(2);
    expect(bobDisplays.length).toBeGreaterThanOrEqual(2);
    // Each display references one of the two trade container serials.
    const containerSerials = new Set([session.containerA, session.containerB]);
    for (const pkt of aliceDisplays) {
      const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
      const serial = dv.getUint32(1);
      expect(containerSerials.has(serial)).toBe(true);
    }
    for (const pkt of bobDisplays) {
      const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
      const serial = dv.getUint32(1);
      expect(containerSerials.has(serial)).toBe(true);
    }
  });

  it('both participants receive 0x3C empty containerContents for both trade containers', () => {
    const aliceContents = alice.sentPackets.filter((b) => b[0] === 0x3C);
    const bobContents   = bob.sentPackets.filter((b) => b[0] === 0x3C);
    expect(aliceContents.length).toBeGreaterThanOrEqual(2);
    expect(bobContents.length).toBeGreaterThanOrEqual(2);
  });

  it('the 0x6F open command is still sent (existing TradeWindow popup)', () => {
    const tradeOpens = alice.sentPackets.filter((b) => b[0] === 0x6F && b[3] === 0x00);
    expect(tradeOpens.length).toBe(1);
  });
});
