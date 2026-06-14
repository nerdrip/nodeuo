// bless/curse — stat buff/debuff via the status-effects framework.

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';
import * as statusEffects from '../src/status-effects.js';

function makeWorld() { return { items: new Map(), mobiles: new Map() }; }

function makeApi(world) {
  const cmds = new Map();
  const map = new Map();
  map.set('reagent-garlic',        { itemId: 3972 });
  map.set('reagent-ginseng',       { itemId: 3977 });
  map.set('reagent-mandrake',      { itemId: 3974 });
  map.set('reagent-nightshade',    { itemId: 3973 });
  map.set('reagent-sulfurous-ash', { itemId: 3980 });
  return {
    world, log: () => {},
    templates: { get: (n) => map.get(n) },
    statusEffects,
    combat: { damage: () => {}, animate: () => {} },
    targeting: { request: () => {} },
    protocol: {
      EffectKind: { FromSource: 0, Moving: 1, Lightning: 2, Stationary: 3 },
      graphicalEffect: () => new Uint8Array([0x70]),
      huedEffect: () => new Uint8Array([0xC0]),
      playSound: () => new Uint8Array([0x54]),
      healthUpdate: () => new Uint8Array([0xA1]),
      manaUpdate: () => new Uint8Array([0xA2]),
      removeEntity: (s) => new Uint8Array([0x1D, s & 0xff]),
      containerContentUpdate: () => new Uint8Array([0x25]),
    },
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    _cmds: cmds,
  };
}

function putItem(world, parent, itemId, amount) {
  const serial = 0x4000_0000 + world.items.size + 1;
  world.items.set(serial, { serial, itemId, parent, amount, x: 0, y: 0, z: 0, map: 1 });
  return serial;
}

describe('bless + curse', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let caster;
  /** @type {any} */ let target;
  /** @type {any} */ let state;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerCast(api);
    caster = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, mana: 80, manaMax: 80,
      skills: { 26: 120 }, // Magery cap → no fizzle.
      client: { send: () => {} },
    };
    target = {
      serial: 0x2002, x: 100, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100,
      str: 50, dex: 50, int: 50, effects: [],
    };
    world.mobiles.set(caster.serial, caster);
    world.mobiles.set(target.serial, target);
    state = { mobile: caster, sendSystemMessage: () => {} };
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: caster }, [name]);
  }

  it('bless raises str/dex/int by +10 and attaches a bless effect', () => {
    putItem(world, caster.serial, 3972, 3); // garlic
    putItem(world, caster.serial, 3977, 3); // ginseng
    putItem(world, caster.serial, 3974, 3); // mandrake
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('bless');
    expect(target.str).toBe(60);
    expect(target.dex).toBe(60);
    expect(target.int).toBe(60);
    expect(statusEffects.has(target, 'bless')).toBe(true);
  });

  it('bless onRemove restores the original stats when the effect expires', () => {
    putItem(world, caster.serial, 3972, 3);
    putItem(world, caster.serial, 3977, 3);
    putItem(world, caster.serial, 3974, 3);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('bless');
    // Force expiry via remove (equivalent to tickAll past expiresAt).
    statusEffects.remove(target, 'bless');
    expect(target.str).toBe(50);
    expect(target.dex).toBe(50);
    expect(target.int).toBe(50);
  });

  it('curse reduces stats by 10 and is cleanly undone on expiry', () => {
    putItem(world, caster.serial, 3972, 3); // garlic
    putItem(world, caster.serial, 3973, 3); // nightshade
    putItem(world, caster.serial, 3980, 3); // sulfurous ash
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('curse');
    expect(target.str).toBe(40);
    statusEffects.remove(target, 'curse');
    expect(target.str).toBe(50);
  });

  it('re-casting bless refreshes rather than stacking stats', () => {
    putItem(world, caster.serial, 3972, 6);
    putItem(world, caster.serial, 3977, 6);
    putItem(world, caster.serial, 3974, 6);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('bless');
    caster.mana = 80; // refill so the second cast doesn't get rejected
    cast('bless');
    // Still only +10 total — replace-on-name fired onRemove before re-apply.
    expect(target.str).toBe(60);
    expect(target.effects.filter((e) => e.name === 'bless')).toHaveLength(1);
  });
});
