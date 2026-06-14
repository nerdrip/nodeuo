// Magery single-stat buffs/debuffs: strength, agility, cunning (buffs)
// and weaken, clumsy, feeblemind (debuffs). Mirrors bless-curse.test.js
// but targets one stat per spell.

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
  function findBackpack(mob) {
    for (const item of world.items.values()) {
      if ((item.parent >>> 0) === (mob?.serial >>> 0) && (item.layer ?? 0) === 21) return item;
    }
    return null;
  }
  const api = {
    world, log: () => {},
    templates: { get: (n) => tpls.get(n) },
    statusEffects,
    combat: { damage: () => {}, animate: () => {} },
    targeting: { request: () => {} },
    items: {
      createItem: (w, opts) => {
        const serial = 0x5000_0000 + w.items.size + 1;
        const item = { serial, ...opts };
        w.items.set(serial, item);
        return item;
      },
    },
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
  api.game = {
    inventory: { findBackpack },
    mobile: {
      giveItem(mob, data = {}, options = {}) {
        const pack = findBackpack(mob);
        if (!pack && options.requireBackpack !== false) return null;
        const gridX = data.gridX ?? data.x ?? 60;
        const gridY = data.gridY ?? data.y ?? 60;
        return api.items.createItem(world, {
          ...data,
          parent: data.parent ?? pack?.serial ?? mob.serial,
          map: data.map ?? mob.map ?? 1,
          x: data.x ?? gridX,
          y: data.y ?? gridY,
          z: data.z ?? 0,
          gridX,
          gridY,
          gridLocation: data.gridLocation ?? 0,
        });
      },
    },
  };
  return api;
}

function putReagents(world, caster, names) {
  for (const n of names) {
    const ids = { garlic: 3972, ginseng: 3977, mandrake: 3974, nightshade: 3973,
      sulf: 3980, silk: 3981, bloodmoss: 3963, blackpearl: 3962 };
    const serial = 0x4000_0000 + world.items.size + 1;
    world.items.set(serial, {
      serial, itemId: ids[n], parent: caster.serial,
      amount: 10, x: 0, y: 0, z: 0, map: 1,
    });
  }
}

describe('Magery single-stat spells', () => {
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
      skills: { 26: 120 },
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

  it('strength raises only str and is cleanly undone on expiry', () => {
    putReagents(world, caster, ['mandrake', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('strength');
    expect(target.str).toBe(60);
    expect(target.dex).toBe(50);
    expect(target.int).toBe(50);
    statusEffects.remove(target, 'strength');
    expect(target.str).toBe(50);
  });

  it('agility raises only dex', () => {
    putReagents(world, caster, ['mandrake', 'bloodmoss']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('agility');
    expect(target.str).toBe(50);
    expect(target.dex).toBe(60);
    expect(target.int).toBe(50);
  });

  it('cunning raises only int', () => {
    putReagents(world, caster, ['mandrake', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('cunning');
    expect(target.int).toBe(60);
    expect(target.str).toBe(50);
  });

  it('weaken lowers only str', () => {
    putReagents(world, caster, ['garlic', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('weaken');
    expect(target.str).toBe(40);
    expect(target.dex).toBe(50);
    statusEffects.remove(target, 'weaken');
    expect(target.str).toBe(50);
  });

  it('clumsy lowers only dex', () => {
    putReagents(world, caster, ['bloodmoss', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('clumsy');
    expect(target.dex).toBe(40);
    expect(target.str).toBe(50);
  });

  it('feeblemind lowers only int', () => {
    putReagents(world, caster, ['nightshade', 'ginseng']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('feeblemind');
    expect(target.int).toBe(40);
    expect(target.dex).toBe(50);
  });

  it('re-casting strength refreshes rather than stacking', () => {
    putReagents(world, caster, ['mandrake', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: target.serial });
    cast('strength');
    caster.mana = 80;
    cast('strength');
    expect(target.str).toBe(60);
    expect(target.effects.filter((e) => e.name === 'strength')).toHaveLength(1);
  });

  it('night-sight applies a long-duration effect on self', () => {
    putReagents(world, caster, ['silk', 'sulf']);
    cast('night-sight');
    expect(statusEffects.has(caster, 'night-sight')).toBe(true);
  });

  it('reactive-armor stamps an AOS resist overlay on self', () => {
    putReagents(world, caster, ['garlic', 'silk', 'sulf']);
    cast('reactive-armor');
    // Audit #36 P1 #1 — was a `reflect: 0.2` flag; now installs a
    // resist overlay (+15 phys / -5 elemental) per ServUO AOS path.
    expect(statusEffects.has(caster, 'reactive-armor')).toBe(true);
    expect(caster._reactiveArmor).toBe(true);
    expect(caster._resistOverlay?.physical).toBeGreaterThanOrEqual(15);
    expect(caster._resistOverlay?.fire).toBe(-5);
  });

  it('protection stamps the indefinite buff + physical resist malus on self', () => {
    // Audit #40 P2 #11 — Protection is now indefinite no-disrupt
    // (ServUO `Protection.cs`); the 0.25 reduce was invented. Real
    // effect: `_protectionUntil` flag + physical resist delta in
    // `_resistOverlay`. Re-cast toggles off.
    putReagents(world, caster, ['garlic', 'ginseng', 'sulf']);
    cast('protection');
    expect((caster._protectionUntil ?? 0) > Date.now()).toBe(true);
    expect(caster._resistOverlay?.physical).toBeLessThan(0);
  });

  it('create-food drops a loaf of bread into the caster\'s pack', () => {
    // Place a backpack on the caster (layer 21) — the spell requires one
    // because UO bread goes IN the bag, not parented to the mobile
    // directly. Earlier the spell silently parented the loaf to the
    // mobile and the inventory window never saw it.
    const packSerial = 0x6000_0001;
    world.items.set(packSerial, {
      serial: packSerial, itemId: 0x0E75, parent: caster.serial, layer: 21,
      x: 0, y: 0, z: 0, map: 1,
    });
    putReagents(world, caster, ['garlic', 'ginseng', 'mandrake']);
    cast('create-food');
    const bread = Array.from(world.items.values()).find((i) => i.itemId === 0x103B);
    expect(bread).toBeTruthy();
    expect(bread.parent).toBe(packSerial);
  });
});
