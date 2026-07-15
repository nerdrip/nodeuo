// Magery circles 3-4: teleport, mana-drain, arch-cure, arch-protection.
// Same stub-api pattern as bless-curse.test.js.

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';
import * as statusEffects from '../src/status-effects.js';

function makeWorld() { return { items: new Map(), mobiles: new Map() }; }

function makeApi(world) {
  const cmds = new Map();
  const tpls = new Map();
  tpls.set('reagent-garlic',        { itemId: 3972 });
  tpls.set('reagent-ginseng',       { itemId: 3977 });
  tpls.set('reagent-mandrake',      { itemId: 3974 });
  tpls.set('reagent-nightshade',    { itemId: 3973 });
  tpls.set('reagent-sulfurous-ash', { itemId: 3980 });
  tpls.set('reagent-spider-silk',   { itemId: 3981 });
  tpls.set('reagent-blood-moss',    { itemId: 3963 });
  tpls.set('reagent-black-pearl',   { itemId: 3962 });
  return {
    world, log: () => {},
    templates: { get: (n) => tpls.get(n) },
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
      mobileUpdate: () => new Uint8Array([0x20]),
      mobileMoving: () => new Uint8Array([0x77]),
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

function putReagents(world, caster, names) {
  const ids = { garlic: 3972, ginseng: 3977, mandrake: 3974, nightshade: 3973,
    sulf: 3980, silk: 3981, bloodmoss: 3963, blackpearl: 3962 };
  for (const n of names) {
    const serial = 0x4000_0000 + world.items.size + 1;
    world.items.set(serial, {
      serial, itemId: ids[n], parent: caster.serial,
      amount: 10, x: 0, y: 0, z: 0, map: 1,
    });
  }
}

describe('Magery circles 3-4', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let caster;
  /** @type {any} */ let state;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerCast(api);
    caster = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      body: 0x0190, hue: 0, flags: 0, direction: 0, notoriety: 1,
      hp: 100, hpMax: 100, mana: 80, manaMax: 80,
      skills: { 26: 120 },
      client: { send: () => {} },
    };
    world.mobiles.set(caster.serial, caster);
    state = { mobile: caster, sendSystemMessage: () => {} };
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: caster }, [name]);
  }

  it('teleport moves the caster to the picked tile', () => {
    putReagents(world, caster, ['bloodmoss', 'mandrake']);
    // Audit #40 P1 #4 — Teleport now caps range at 11 tiles (ServUO
    // `Teleport.cs:67-84`). Was: any-distance cross-map teleport.
    // Caster sits at (100,100) per beforeEach; pick within range.
    api.targeting.request = (_s, cb) => cb({ x: 105, y: 108, z: 5 });
    cast('teleport');
    expect(caster.x).toBe(105);
    expect(caster.y).toBe(108);
    expect(caster.z).toBe(5);
  });

  it('teleport uses kind=1 (location targeting)', () => {
    putReagents(world, caster, ['bloodmoss', 'mandrake']);
    let kind = null;
    api.targeting.request = (_s, _cb, opts) => { kind = opts?.kind; };
    cast('teleport');
    expect(kind).toBe(1);
  });

  it('recall uses the rune selected by the object cursor', () => {
    putReagents(world, caster, ['blackpearl', 'bloodmoss', 'mandrake']);
    const rune = {
      serial: 0x4000ff01, itemId: 0x1F14,
      x: 100, y: 100, z: 0, map: 1,
      runeDest: { x: 107, y: 104, z: 3, map: 1, label: 'audit rune' },
    };
    world.items.set(rune.serial, rune);
    api.targeting.request = (_s, cb) => cb({ serial: rune.serial });
    cast('recall');
    expect(caster).toMatchObject({ x: 107, y: 104, z: 3, map: 1 });
  });

  it('mana-drain reduces target mana', () => {
    // Audit #36 P2 #9 — ServUO Mana Drain drains `40 + (EvalInt-Resist)`.
    // With both at 0 the formula = 40. Victim seeded with 100 mana so
    // the post-drain band 50..70 is generous enough to absorb tiny
    // tuning drift while still catching a "no drain" regression.
    const victim = {
      serial: 0x2001, x: 100, y: 100, z: 0, map: 1,
      mana: 100, manaMax: 100, hp: 100, hpMax: 100,
      effects: [],
    };
    world.mobiles.set(victim.serial, victim);
    putReagents(world, caster, ['blackpearl', 'mandrake', 'silk']);
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('mana-drain');
    expect(victim.mana).toBeLessThan(100);
    expect(victim.mana).toBeGreaterThanOrEqual(50);
  });

  it('arch-cure removes poison in radius 2 from picked point', () => {
    const inRange = {
      serial: 0x3001, x: 102, y: 100, z: 0, map: 1, effects: [],
    };
    const outRange = {
      serial: 0x3002, x: 105, y: 100, z: 0, map: 1, effects: [],
    };
    world.mobiles.set(inRange.serial, inRange);
    world.mobiles.set(outRange.serial, outRange);
    statusEffects.apply(inRange,  { name: 'poison', durationMs: 20_000 });
    statusEffects.apply(outRange, { name: 'poison', durationMs: 20_000 });

    putReagents(world, caster, ['garlic', 'ginseng', 'mandrake']);
    api.targeting.request = (_s, cb) => cb({ x: 100, y: 100, z: 0 });
    cast('arch-cure');
    expect(statusEffects.has(inRange, 'poison')).toBe(false);
    expect(statusEffects.has(outRange, 'poison')).toBe(true);
  });

  it('arch-protection stamps protection on everyone in radius 2', () => {
    const target = {
      serial: 0x3003, x: 101, y: 99, z: 0, map: 1, effects: [],
    };
    world.mobiles.set(target.serial, target);
    putReagents(world, caster, ['garlic', 'ginseng', 'mandrake', 'sulf']);
    api.targeting.request = (_s, cb) => cb({ x: 100, y: 100, z: 0 });
    cast('arch-protection');
    expect(statusEffects.has(target, 'protection')).toBe(true);
    expect(statusEffects.has(caster, 'protection')).toBe(true);
  });
});
