// Healer NPC behavior: resurrects nearby ghosts, heals wounded friendlies,
// skips monsters. Mirrors the direct-tick pattern used in mage-ai.test.js.

import { describe, it, expect, beforeEach } from 'vitest';
import registerHealer from '../../scripts/src/npcs/vendors/healer.js';
import { contextMenus } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';

function makeApi(world) {
  let behavior = null;
  const resurrected = [];
  return {
    world,
    log: () => {},
    ai: {
      registerBehavior(b) { behavior = b; },
      unregisterBehavior() {},
      attach() {},
      stepMobile() { return true; },
    },
    corpse: {
      resurrectMobile: (_w, mob) => {
        mob.ghost = false;
        mob.hp = Math.max(1, Math.floor((mob.hpMax ?? 50) / 2));
        resurrected.push(mob.serial);
      },
    },
    npcs: { get: () => null },
    protocol: {
      EffectKind: { FromSource: 0, Moving: 1, Lightning: 2, Stationary: 3 },
      huedEffect: () => new Uint8Array([0xC0]),
      healthUpdate: () => new Uint8Array([0xA1]),
      mobileIncoming: () => new Uint8Array([0x78]),
    },
    commands: { register: () => {}, unregister: () => {} },
    _behavior: () => behavior,
    _resurrected: resurrected,
  };
}

function makeWorld() { return { mobiles: new Map() }; }

describe('healer NPC behavior', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let healer;
  /** @type {any} */ let state;
  /** @type {any} */ let behavior;
  /** @type {string[]} */ let spoken;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerHealer(api);
    behavior = api._behavior();
    healer = {
      serial: 0x4001, x: 100, y: 100, z: 0, map: 1,
      body: 401, direction: 0, hue: 0, notoriety: 1,
      hp: 80, hpMax: 80, int: 90,
    };
    world.mobiles.set(healer.serial, healer);
    state = behavior.initState();
    spoken = [];
  });

  function tick(now) {
    behavior.tick({
      world, now,
      broadcastMove: () => {},
      broadcastSpeech: (_m, text) => { spoken.push(text); },
    }, healer, state);
  }

  it('heals a wounded innocent player nearby', () => {
    const player = {
      serial: 0x5001, x: 103, y: 100, z: 0, map: 1,
      hp: 30, hpMax: 100, notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(player.serial, player);
    tick(1000);
    expect(player.hp).toBeGreaterThan(30);
    expect(spoken).toContain('Be at peace.');
  });

  it('resurrects a nearby ghost and prefers it over healing', () => {
    const ghost = {
      serial: 0x5002, x: 101, y: 100, z: 0, map: 1,
      hp: 0, hpMax: 60, ghost: true, notoriety: 1,
      client: { send: () => {} },
    };
    const wounded = {
      serial: 0x5003, x: 102, y: 100, z: 0, map: 1,
      hp: 10, hpMax: 100, notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(ghost.serial, ghost);
    world.mobiles.set(wounded.serial, wounded);
    tick(1000);
    expect(api._resurrected).toContain(ghost.serial);
    // Only one action per tick — the wounded still needs another pass.
    expect(wounded.hp).toBe(10);
  });

  it('refuses to heal hostile monsters (notoriety 5 = murderer/monster)', () => {
    const orc = {
      serial: 0x5004, x: 102, y: 100, z: 0, map: 1,
      hp: 20, hpMax: 100, notoriety: 5,
    };
    world.mobiles.set(orc.serial, orc);
    tick(1000);
    expect(orc.hp).toBe(20);
  });

  it('does nothing when nobody nearby needs help', () => {
    const tourist = {
      serial: 0x5005, x: 105, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, notoriety: 1,
    };
    world.mobiles.set(tourist.serial, tourist);
    tick(1000);
    expect(spoken).toHaveLength(0);
    expect(tourist.hp).toBe(100);
  });

  it('respects the cooldown — no second heal inside the same cooldown window', () => {
    const player = {
      serial: 0x5006, x: 101, y: 100, z: 0, map: 1,
      hp: 30, hpMax: 100, notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(player.serial, player);
    tick(1000);
    const hpAfterFirst = player.hp;
    tick(2000); // inside the 3000ms cooldown
    expect(player.hp).toBe(hpAfterFirst);
    tick(4500); // past cooldown
    expect(player.hp).toBeGreaterThan(hpAfterFirst);
  });

  it('caps healing amount for non-player (no client) patients', () => {
    const npc = {
      serial: 0x5007, x: 101, y: 100, z: 0, map: 1,
      hp: 10, hpMax: 200, notoriety: 1,   // no .client
    };
    world.mobiles.set(npc.serial, npc);
    healer.int = 200; // a very smart healer
    tick(1000);
    // Full formula would be 10 + 200/10 = 30, but NPC cap pins at 15.
    expect(npc.hp - 10).toBeLessThanOrEqual(15);
  });

  it('answers an explicit speech request from the addressed player', () => {
    const player = {
      serial: 0x5008, x: 101, y: 100, z: 0, map: 1,
      hp: 25, hpMax: 100, notoriety: 1, client: { send: () => {} },
    };
    healer._heardSpeech = [{ speaker: player, text: 'please heal me', hue: 0 }];
    world.mobiles.set(player.serial, player);

    tick(1000);

    expect(player.hp).toBeGreaterThan(25);
    expect(healer._heardSpeech).toHaveLength(0);
    expect(spoken).toContain('Be at peace.');
  });

  it('turns a healer double-click into a queued aid request', () => {
    const player = {
      serial: 0x5009, x: 101, y: 100, z: 0, map: 1,
      hp: 25, hpMax: 100, notoriety: 1,
    };
    world.mobiles.set(player.serial, player);
    healer.kind = 'healer';
    const messages = [];

    contextMenus.use({
      stage: Stage.InWorld, mobile: player, ctx: { world },
      send() {}, sendSystemMessage: (message) => messages.push(message),
    }, healer.serial);

    expect(healer._heardSpeech).toEqual([{ speaker: player, text: 'heal', hue: 0 }]);
    expect(messages.join(' ')).toContain('will tend to you');
  });
});
