// Spell-casting branch of the aggressive NPC behavior.
// Drives the behavior.tick directly through a fake script api, so we can
// step time forward and assert cast cadence / mana drain without standing
// up the real AIScheduler.

import { describe, it, expect, beforeEach } from 'vitest';
import registerAggressive from '../../scripts/src/npcs/ai/aggressive.js';

function makeApi(world) {
  let behavior = null;
  const damagedLog = [];
  return {
    world,
    log: () => {},
    ai: {
      registerBehavior(b) { behavior = b; },
      unregisterBehavior() {},
      attach() {},
      stepMobile() { return true; },
      findPath() { return null; },
    },
    combat: {
      damage: (_w, mob, amt) => {
        mob.hp = Math.max(0, (mob.hp ?? 50) - amt);
        damagedLog.push({ serial: mob.serial, amt });
      },
      animate: () => {},
      hitChance: () => 1.0,
      rollDamage: () => 5,
    },
    corpse: { killMobile: () => {} },
    monsters: {
      get: (kind) => (kind === 'mage-test' ? makeMageCfg() : null),
      kinds: () => ['mage-test'],
    },
    protocol: {
      EffectKind: { FromSource: 0, Moving: 1, Lightning: 2, Stationary: 3 },
      huedEffect: () => new Uint8Array([0xC0]),
      playSound: () => new Uint8Array([0x54]),
      mobileIncoming: () => new Uint8Array([0x78]),
    },
    commands: { register: () => {}, unregister: () => {} },
    _behavior: () => behavior,
    _damagedLog: damagedLog,
  };
}

function makeMageCfg() {
  return {
    name: 'test-mage', body: 400, hue: 0,
    hp: 80, hpMax: 80, str: 50,
    int: 80, mana: 80, manaMax: 80,
    aggroRange: 10, attackInterval: 1800,
    castInterval: 2000, spellRange: 10,
    spells: [
      { name: 'magic-arrow', mana: 4, damage: [6, 10] },
      { name: 'fireball',    mana: 9, damage: [10, 15] },
    ],
    bravery: 1, // suppress flee — we want to observe cast cadence.
  };
}

function makeWorld() {
  return { mobiles: new Map() };
}

describe('mage AI spell-cast branch', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let mage;
  /** @type {any} */ let player;
  /** @type {any} */ let state;
  /** @type {any} */ let behavior;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerAggressive(api);
    behavior = api._behavior();
    mage = {
      serial: 0x2001, x: 100, y: 100, z: 0, map: 1,
      body: 400, direction: 0, hue: 0, flags: 0, notoriety: 5,
      hp: 80, hpMax: 80, mana: 80, manaMax: 80, int: 80, str: 50,
    };
    player = {
      serial: 0x3001, x: 105, y: 100, z: 0, map: 1, // 5 tiles east
      hp: 100, hpMax: 100, client: { send: () => {} },
    };
    world.mobiles.set(mage.serial, mage);
    world.mobiles.set(player.serial, player);
    state = behavior.initState();
    state.kind = 'mage-test';
  });

  function tick(now) {
    behavior.tick({
      world, now,
      broadcastMove: () => {},
      broadcastSpeech: () => {},
    }, mage, state);
  }

  it('casts a spell instead of closing to melee when target is at range', () => {
    const hpBefore = player.hp;
    const manaBefore = mage.mana;
    tick(1000);
    expect(player.hp).toBeLessThan(hpBefore);
    expect(mage.mana).toBeLessThan(manaBefore);
    // The target should have been damaged exactly once this tick.
    expect(api._damagedLog.filter((d) => d.serial === player.serial)).toHaveLength(1);
  });

  it('respects castInterval between casts', () => {
    tick(1000);
    const damageAfterFirst = api._damagedLog.length;
    tick(1500); // under castInterval (2000)
    expect(api._damagedLog.length).toBe(damageAfterFirst);
    tick(3100); // past castInterval
    expect(api._damagedLog.length).toBe(damageAfterFirst + 1);
  });

  it('falls back to melee/chase when out of mana', () => {
    mage.mana = 0;
    const hpBefore = player.hp;
    tick(1000);
    // No cast → no ranged damage at 5 tiles.
    expect(player.hp).toBe(hpBefore);
  });

  it('does not cast when adjacent (dist < 2) — reserves that range for melee', () => {
    player.x = 101; // 1 tile away
    const manaBefore = mage.mana;
    tick(1000);
    expect(mage.mana).toBe(manaBefore);
  });
});
