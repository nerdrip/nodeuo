// Paralyze — cast adds a 'paralyze' status effect; stepMobile refuses to
// move any mob whose effects list carries it.

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';
import * as statusEffects from '../src/status-effects.js';
import { stepMobile } from '../src/world/ai.js';

function makeWorld() { return { items: new Map(), mobiles: new Map() }; }

function makeApi(world) {
  const cmds = new Map();
  const reagents = new Map([
    ['reagent-garlic',       { itemId: 3972 }],
    ['reagent-mandrake',     { itemId: 3974 }],
    ['reagent-spider-silk',  { itemId: 3981 }],
  ]);
  return {
    world, log: () => {},
    templates: { get: (n) => reagents.get(n) },
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
      removeEntity: () => new Uint8Array([0x1D]),
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

describe('paralyze spell + movement lockout', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let caster;
  /** @type {any} */ let target;
  /** @type {any} */ let state;

  beforeEach(() => {
    // Safety: other tests register this listener module-globally.
    statusEffects.setListener(null);
    world = makeWorld();
    api = makeApi(world);
    registerCast(api);
    caster = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, mana: 80, manaMax: 80,
      skills: { 26: 120 },
      client: { send: () => {} },
    };
    target = {
      serial: 0x2002, x: 200, y: 200, z: 0, map: 1,
      hp: 100, hpMax: 100, direction: 0, effects: [],
    };
    world.mobiles.set(caster.serial, caster);
    world.mobiles.set(target.serial, target);
    state = { mobile: caster, sendSystemMessage: () => {} };
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: caster }, [name]);
  }

  it('attaches a paralyze status effect with a positive duration', () => {
    putItem(world, caster.serial, 3972, 3); // garlic
    putItem(world, caster.serial, 3974, 3); // mandrake
    putItem(world, caster.serial, 3981, 3); // spider silk
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('paralyze');
    const eff = target.effects.find((e) => e.name === 'paralyze');
    expect(eff).toBeDefined();
    expect(eff.expiresAt).toBeGreaterThan(Date.now());
  });

  it('stepMobile refuses to move a paralyzed mob, even when the tile is free', () => {
    // Short-circuit resolveStep: a far-from-origin position where no statics
    // are loaded — ServUO's resolver treats uncharted land as walkable-at-0.
    // So an unparalyzed step would succeed.
    const before = { x: target.x, y: target.y };
    target.effects = [{
      name: 'paralyze', expiresAt: Date.now() + 10_000,
      lastTickAt: 0, tickIntervalMs: 0, data: {},
    }];
    expect(stepMobile(target, 2 /* east */)).toBe(false);
    expect(target.x).toBe(before.x);
    expect(target.y).toBe(before.y);
  });

  it('stepMobile walks the mob normally once the paralyze effect expires', () => {
    target.effects = [{
      name: 'paralyze', expiresAt: Date.now() - 1, // already expired
      lastTickAt: 0, tickIntervalMs: 0, data: {},
    }];
    // Simulate the sweeper removing the expired effect.
    statusEffects.tickAll(world, Date.now());
    expect(target.effects).toHaveLength(0);
    const moved = stepMobile(target, 2);
    expect(moved).toBe(true);
  });

  it('capped duration for player targets keeps lockout at or below 12s', () => {
    // A tamed wolf or skeleton (target.client == null) gets the full scaled
    // duration; a player (with .client) is capped at 12 seconds so perma-
    // lock at max magery is impossible.
    putItem(world, caster.serial, 3972, 3);
    putItem(world, caster.serial, 3974, 3);
    putItem(world, caster.serial, 3981, 3);
    target.client = { send: () => {} };
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('paralyze');
    const eff = target.effects.find((e) => e.name === 'paralyze');
    const remaining = eff.expiresAt - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(12_000);
  });
});
