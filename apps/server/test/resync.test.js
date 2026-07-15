// 0x22 ClientResyncRequest → re-stream surroundings.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildHandlers } from '../src/net/handlers.js';
import { World } from '../src/world/world.js';

describe('handleResynchronize', () => {
  /** @type {any} */ let state;
  /** @type {any} */ let world;
  /** @type {Uint8Array[]} */ let sent;
  /** @type {any} */ let handlers;

  beforeEach(() => {
    world = new World();
    sent = [];
    const player = {
      serial: 0x1001, name: 'tester',
      body: 400, hue: 0, flags: 0, notoriety: 1,
      x: 100, y: 100, z: 0, map: 1, direction: 0,
      hp: 80, hpMax: 100,
      client: { send: (b) => sent.push(b) },
    };
    world.mobiles.set(player.serial, player);
    state = {
      stage: 'inWorld', mobile: player,
      ctx: { world, config: {}, },
      send(bytes) { sent.push(bytes); },
      sendItem(item) { sent.push(new Uint8Array([0xF3, item.serial & 0xff])); },
    };
    handlers = buildHandlers();
  });

  function callResync() {
    handlers[0x22](state, new Uint8Array([0x22]));
  }

  it('is a no-op before the player is in world', () => {
    state.stage = 'charList';
    callResync();
    expect(sent).toHaveLength(0);
  });

  it('re-streams self (mobileUpdate + mobileIncoming + healthUpdate)', () => {
    callResync();
    const ops = sent.map((p) => p[0]);
    expect(ops).toContain(0x20);  // mobileUpdate
    expect(ops).toContain(0x78);  // mobileIncoming
    expect(ops).toContain(0xA1);  // healthUpdate
  });

  it('always answers burst resyncs with an authoritative self snap', () => {
    callResync();
    sent.length = 0;
    callResync();
    expect(sent.map((p) => p[0])).toEqual([0x20]);
  });

  it('re-streams nearby NPC mobiles — not just other players', () => {
    // Seed a stationary NPC (no client) within update range. Resync must
    // still tell the resyncing player about it, otherwise the sprite is
    // lost for good after the stall.
    world.mobiles.set(0x2002, {
      serial: 0x2002, name: 'orc', body: 17, hue: 0, flags: 0, notoriety: 5,
      x: 105, y: 100, z: 0, map: 1, direction: 0,
      hp: 80, hpMax: 80,
    });
    callResync();
    // At least two 0x78s: self + orc.
    const incomings = sent.filter((p) => p[0] === 0x78);
    expect(incomings.length).toBeGreaterThanOrEqual(2);
  });

  it('re-streams nearby ground items', () => {
    world.items.set(0x4000_0001, {
      serial: 0x4000_0001, itemId: 0x0EED, amount: 1,
      x: 102, y: 101, z: 0, map: 1, parent: null,
    });
    callResync();
    // sendItem wrapper pushes a marker byte; at least one such packet went out.
    expect(sent.some((p) => p[0] === 0xF3)).toBe(true);
  });

  it('never streams invisible technical ground triggers', () => {
    world.items.set(0x4000_0001, {
      serial: 0x4000_0001, itemId: 0x1BCB, amount: 1,
      x: 100, y: 100, z: 0, map: 1, parent: null,
      visible: false, script: 'teleporter',
    });
    callResync();
    expect(sent.some((p) => p[0] === 0xF3)).toBe(false);
  });

  it('does not send NPC/item packets for things out of update range', () => {
    world.mobiles.set(0x2002, {
      serial: 0x2002, body: 17, hue: 0, flags: 0, notoriety: 5,
      x: 9000, y: 9000, z: 0, map: 1, direction: 0,
      hp: 80, hpMax: 80,
    });
    world.items.set(0x4000_0001, {
      serial: 0x4000_0001, itemId: 0x0EED,
      x: 9000, y: 9000, z: 0, map: 1, parent: null,
    });
    callResync();
    // Only self 0x78 is sent (+ 0x20 + 0xA1). No item packet.
    expect(sent.filter((p) => p[0] === 0x78)).toHaveLength(1);
    expect(sent.some((p) => p[0] === 0xF3)).toBe(false);
  });

  it('removes serials from the previous visibility window that are no longer nearby', () => {
    state._visibleItems = new Set([0x4000_1234]);
    state._visibleMobiles = new Set([0x2000_1234]);
    callResync();
    const removed = sent
      .filter((p) => p[0] === 0x1D)
      .map((p) => ((p[1] << 24) | (p[2] << 16) | (p[3] << 8) | p[4]) >>> 0);
    expect(removed).toContain(0x4000_1234);
    expect(removed).toContain(0x2000_1234);
  });
});
