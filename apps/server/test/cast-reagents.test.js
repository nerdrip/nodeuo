// Reagent consumption + missing-reagent rejection for [cast.
// Drives the command directly through a fake script api.

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';

function makeWorld() {
  return { items: new Map(), mobiles: new Map() };
}

function makeTemplates() {
  const map = new Map();
  // Only the reagents [cast currently touches.
  map.set('reagent-garlic',        { itemId: 3972 });
  map.set('reagent-ginseng',       { itemId: 3977 });
  map.set('reagent-spider-silk',   { itemId: 3981 });
  map.set('reagent-mandrake',      { itemId: 3974 });
  map.set('reagent-sulfurous-ash', { itemId: 3980 });
  map.set('reagent-black-pearl',   { itemId: 3962 });
  map.set('reagent-nightshade',    { itemId: 3973 });
  return { get(n) { return map.get(n); } };
}

function makeApi(world) {
  const cmds = new Map();
  const updates = [];
  return {
    world,
    log: () => {},
    templates: makeTemplates(),
    combat: {
      damage: (_w, t, d) => { t.hp = Math.max(0, (t.hp ?? 50) - d); },
      animate: () => {},
    },
    // Target-prompt stub: auto-selects the casting mobile so spells
    // that switched to `needsTarget: true` (e.g. Heal / Greater Heal,
    // per ServUO Heal.cs) still resolve self-heal in tests.
    targeting: { request: (state, cb) => cb?.({ serial: state.mobile.serial }) },
    protocol: {
      EffectKind: { FromSource: 0, Moving: 1, Lightning: 2, Stationary: 3 },
      graphicalEffect: () => new Uint8Array([0x70]),
      huedEffect: () => new Uint8Array([0xC0]),
      playSound: () => new Uint8Array([0x54]),
      healthUpdate: () => new Uint8Array([0xA1]),
      manaUpdate: () => new Uint8Array([0xA2]),
      removeEntity: (s) => new Uint8Array([0x1D, (s >>> 24) & 0xff]),
      containerContentUpdate: (entry, parent) => {
        updates.push({ entry, parent });
        return new Uint8Array([0x25, entry.serial & 0xff]);
      },
    },
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    _cmds: cmds,
    _updates: updates,
  };
}

function putReagent(world, parentSerial, templateName, amount) {
  const itemIdMap = {
    'reagent-garlic': 3972, 'reagent-ginseng': 3977,
    'reagent-spider-silk': 3981, 'reagent-mandrake': 3974,
    'reagent-sulfurous-ash': 3980, 'reagent-black-pearl': 3962,
    'reagent-nightshade': 3973,
  };
  const serial = 0x4000_0000 + world.items.size + 1;
  world.items.set(serial, {
    serial, itemId: itemIdMap[templateName], parent: parentSerial,
    amount, x: 0, y: 0, z: 0, map: 1,
  });
  return serial;
}

describe('[cast reagents', () => {
  /** @type {ReturnType<typeof makeWorld>} */ let world;
  /** @type {ReturnType<typeof makeApi>} */   let api;
  /** @type {any} */ let mob;
  /** @type {any} */ let state;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerCast(api);
    const sent = [];
    mob = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      hp: 30, hpMax: 60, mana: 50, manaMax: 50,
      // Magery 120 — at the per-skill cap and above every spell's
      // maxSkill (top is flame-strike's 110), so the ServUO fizzle
      // check never trips. The fizzle pipeline itself is exercised in
      // cast-fizzle.test.js.
      skills: { 26: 120 },
      client: { send: (b) => sent.push(b) },
      _sent: sent,
    };
    world.mobiles.set(mob.serial, mob);
    const sysmsgs = [];
    state = { mobile: mob, sendSystemMessage: (m) => sysmsgs.push(m), _sysmsgs: sysmsgs };
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: mob }, [name]);
  }

  it('heal consumes one of each reagent and restores hp', () => {
    const g = putReagent(world, mob.serial, 'reagent-garlic', 3);
    const i = putReagent(world, mob.serial, 'reagent-ginseng', 3);
    const s = putReagent(world, mob.serial, 'reagent-spider-silk', 1);
    cast('heal');
    expect(mob.hp).toBeGreaterThan(30);
    expect(world.items.get(g).amount).toBe(2);
    expect(world.items.get(i).amount).toBe(2);
    // Spider silk had 1 — now removed.
    expect(world.items.has(s)).toBe(false);
  });

  it('consumes reagents from nested reagent bags and updates that bag', () => {
    const bag = { serial: 0x4000_1000, itemId: 0x0E76, parent: mob.serial, amount: 1 };
    world.items.set(bag.serial, bag);
    const g = putReagent(world, bag.serial, 'reagent-garlic', 3);
    const i = putReagent(world, bag.serial, 'reagent-ginseng', 3);
    const s = putReagent(world, bag.serial, 'reagent-spider-silk', 3);

    cast('heal');

    expect(mob.hp).toBeGreaterThan(30);
    expect(world.items.get(g).amount).toBe(2);
    expect(world.items.get(i).amount).toBe(2);
    expect(world.items.get(s).amount).toBe(2);
    expect(api._updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parent: bag.serial, entry: expect.objectContaining({ serial: g, amount: 2 }) }),
        expect.objectContaining({ parent: bag.serial, entry: expect.objectContaining({ serial: i, amount: 2 }) }),
        expect.objectContaining({ parent: bag.serial, entry: expect.objectContaining({ serial: s, amount: 2 }) }),
      ]),
    );
  });

  it('rejects cast when a reagent is missing and does not touch mana', () => {
    putReagent(world, mob.serial, 'reagent-garlic', 3);
    putReagent(world, mob.serial, 'reagent-ginseng', 3);
    // Missing spider silk.
    const manaBefore = mob.mana;
    cast('heal');
    expect(mob.mana).toBe(manaBefore);
    expect(state._sysmsgs.join(' ')).toMatch(/spider-silk|silk/);
  });

  it('rejects when mana is insufficient even with reagents', () => {
    mob.mana = 2;
    putReagent(world, mob.serial, 'reagent-garlic', 3);
    putReagent(world, mob.serial, 'reagent-ginseng', 3);
    putReagent(world, mob.serial, 'reagent-spider-silk', 3);
    cast('heal');
    expect(state._sysmsgs.join(' ')).toMatch(/mana/i);
    // Reagents untouched.
    for (const it of world.items.values()) expect(it.amount).toBe(3);
  });

  it('fireball consumes black pearl + sulfurous ash', () => {
    const other = { serial: 0x2002, x: 100, y: 100, z: 0, map: 1, hp: 40, hpMax: 40 };
    world.mobiles.set(other.serial, other);
    const bp = putReagent(world, mob.serial, 'reagent-black-pearl', 2);
    const sa = putReagent(world, mob.serial, 'reagent-sulfurous-ash', 2);
    // Fireball needs target — simulate by invoking the spell's cast directly
    // via a fake targeting.request that fires callback.
    api.targeting.request = (_s, cb) => cb({ serial: other.serial });
    cast('fireball');
    expect(world.items.get(bp).amount).toBe(1);
    expect(world.items.get(sa).amount).toBe(1);
    expect(other.hp).toBeLessThan(40);
  });

  it('energy-bolt damages and consumes black pearl + nightshade', () => {
    const other = { serial: 0x2002, x: 100, y: 100, z: 0, map: 1, hp: 60, hpMax: 60 };
    world.mobiles.set(other.serial, other);
    const bp = putReagent(world, mob.serial, 'reagent-black-pearl', 2);
    const ns = putReagent(world, mob.serial, 'reagent-nightshade', 2);
    api.targeting.request = (_s, cb) => cb({ serial: other.serial });
    cast('energy-bolt');
    expect(world.items.get(bp).amount).toBe(1);
    expect(world.items.get(ns).amount).toBe(1);
    expect(other.hp).toBeLessThan(60);
  });

  it('flame-strike damages and consumes spider silk + sulfurous ash', () => {
    const other = { serial: 0x2002, x: 100, y: 100, z: 0, map: 1, hp: 80, hpMax: 80 };
    world.mobiles.set(other.serial, other);
    const ss = putReagent(world, mob.serial, 'reagent-spider-silk', 2);
    const sa = putReagent(world, mob.serial, 'reagent-sulfurous-ash', 2);
    api.targeting.request = (_s, cb) => cb({ serial: other.serial });
    cast('flame-strike');
    expect(world.items.get(ss).amount).toBe(1);
    expect(world.items.get(sa).amount).toBe(1);
    expect(other.hp).toBeLessThan(80);
  });

  it('mind-blast consumes all four reagents', () => {
    const other = { serial: 0x2002, x: 100, y: 100, z: 0, map: 1, hp: 50, hpMax: 50 };
    world.mobiles.set(other.serial, other);
    const bp = putReagent(world, mob.serial, 'reagent-black-pearl', 2);
    const md = putReagent(world, mob.serial, 'reagent-mandrake', 2);
    const ns = putReagent(world, mob.serial, 'reagent-nightshade', 2);
    const sa = putReagent(world, mob.serial, 'reagent-sulfurous-ash', 2);
    api.targeting.request = (_s, cb) => cb({ serial: other.serial });
    cast('mind-blast');
    expect(world.items.get(bp).amount).toBe(1);
    expect(world.items.get(md).amount).toBe(1);
    expect(world.items.get(ns).amount).toBe(1);
    expect(world.items.get(sa).amount).toBe(1);
    expect(other.hp).toBeLessThan(50);
  });
});
