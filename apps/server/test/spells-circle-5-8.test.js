// Magery circles 5-8 batch: invisibility/reveal, dispel, explosion,
// mass-curse, chain-lightning, meteor-swarm, earthquake, resurrection.
//
// Same stub-api pattern as bless-curse.test.js. Damage goes through
// api.combat.damage which we capture so we can assert hit count + totals
// without linking the real combat module.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';
import * as statusEffects from '../src/status-effects.js';

function makeWorld() { return { items: new Map(), mobiles: new Map() }; }

function makeApi(world) {
  const cmds = new Map();
  const damaged = [];
  const resurrected = [];
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
    combat: {
      damage: (_w, mob, dmg) => {
        damaged.push({ serial: mob.serial, dmg });
        mob.hp = Math.max(0, (mob.hp ?? 0) - dmg);
      },
      animate: () => {},
    },
    targeting: { request: () => {} },
    corpse: {
      resurrectMobile: (_w, mob) => {
        mob.ghost = false;
        mob.hp = Math.floor((mob.hpMax ?? 50) / 2);
        resurrected.push(mob.serial);
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
    _damaged: damaged,
    _resurrected: resurrected,
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

describe('Magery circles 5-8', () => {
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
      hp: 100, hpMax: 100, mana: 200, manaMax: 200,
      skills: { 26: 120 },
      client: { send: () => {} },
    };
    world.mobiles.set(caster.serial, caster);
    state = { mobile: caster, sendSystemMessage: () => {} };
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: caster }, [name]);
  }

  function putMob(serial, x, y) {
    const mob = {
      serial, x, y, z: 0, map: 1,
      hp: 100, hpMax: 100, str: 50, dex: 50, int: 50,
      notoriety: 3, effects: [],
    };
    world.mobiles.set(serial, mob);
    return mob;
  }

  it('invisibility hides the target and stamps the effect', () => {
    const victim = putMob(0x2001, 101, 100);
    putReagents(world, caster, ['bloodmoss', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('invisibility');
    expect(victim.hidden).toBe(true);
    expect(statusEffects.has(victim, 'invisibility')).toBe(true);
  });

  it('invisibility cleanly un-hides on removal', () => {
    const victim = putMob(0x2001, 101, 100);
    putReagents(world, caster, ['bloodmoss', 'nightshade']);
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('invisibility');
    statusEffects.remove(victim, 'invisibility');
    expect(victim.hidden).toBe(false);
  });

  it('reveal strips invisibility in radius 2', () => {
    const m1 = putMob(0x2002, 101, 100);
    const m2 = putMob(0x2003, 106, 100); // out of range
    statusEffects.apply(m1, { name: 'invisibility', durationMs: 30_000 });
    statusEffects.apply(m2, { name: 'invisibility', durationMs: 30_000 });
    m1.hidden = true; m2.hidden = true;
    putReagents(world, caster, ['bloodmoss', 'sulf']);
    api.targeting.request = (_s, cb) => cb({ x: 100, y: 100, z: 0 });
    cast('reveal');
    expect(statusEffects.has(m1, 'invisibility')).toBe(false);
    expect(statusEffects.has(m2, 'invisibility')).toBe(true);
  });

  it('dispel strips non-poison effects from the target', () => {
    const v = putMob(0x2004, 100, 100);
    statusEffects.apply(v, { name: 'bless', durationMs: 60_000 });
    statusEffects.apply(v, { name: 'poison', durationMs: 20_000 });
    putReagents(world, caster, ['garlic', 'mandrake', 'sulf']);
    api.targeting.request = (_s, cb) => cb({ serial: v.serial });
    cast('dispel');
    expect(statusEffects.has(v, 'bless')).toBe(false);
    expect(statusEffects.has(v, 'poison')).toBe(true);
  });

  it('mass-curse debuffs every mob in radius 2 (excluding caster)', () => {
    const m1 = putMob(0x2005, 101, 100);
    const m2 = putMob(0x2006, 102, 101);
    const m3 = putMob(0x2007, 105, 100); // out of range
    putReagents(world, caster, ['garlic', 'mandrake', 'nightshade', 'sulf']);
    api.targeting.request = (_s, cb) => cb({ x: 100, y: 100, z: 0 });
    cast('mass-curse');
    expect(m1.str).toBe(40);
    expect(m2.str).toBe(40);
    expect(m3.str).toBe(50);
    expect(caster.str).toBeUndefined();
  });

  it('chain-lightning hits up to 4 targets', () => {
    for (let i = 0; i < 6; i++) putMob(0x3000 + i, 100 + i, 100);
    putReagents(world, caster, ['blackpearl', 'bloodmoss', 'mandrake', 'sulf']);
    api.targeting.request = (_s, cb) => cb({ x: 101, y: 100, z: 0 });
    cast('chain-lightning');
    // 5 targets within distance 3 (100..103 + 104), but capped at 4.
    expect(api._damaged.length).toBeLessThanOrEqual(4);
    expect(api._damaged.length).toBeGreaterThan(0);
  });

  it('meteor-swarm damages every target in radius 3', () => {
    const m1 = putMob(0x4001, 100, 100);
    const m2 = putMob(0x4002, 102, 102);
    const m3 = putMob(0x4003, 110, 100); // out of range
    putReagents(world, caster, ['bloodmoss', 'silk', 'sulf', 'mandrake']);
    api.targeting.request = (_s, cb) => cb({ x: 101, y: 100, z: 0 });
    cast('meteor-swarm');
    const hitSerials = api._damaged.map((d) => d.serial);
    expect(hitSerials).toContain(m1.serial);
    expect(hitSerials).toContain(m2.serial);
    expect(hitSerials).not.toContain(m3.serial);
  });

  it('earthquake damages every non-caster mob in radius 6', () => {
    const near = putMob(0x5001, 104, 102);
    const far = putMob(0x5002, 200, 200);
    putReagents(world, caster, ['bloodmoss', 'ginseng', 'mandrake', 'sulf']);
    cast('earthquake');
    const hitSerials = api._damaged.map((d) => d.serial);
    expect(hitSerials).toContain(near.serial);
    expect(hitSerials).not.toContain(far.serial);
    expect(hitSerials).not.toContain(caster.serial);
  });

  it('resurrection raises a ghost via api.corpse.resurrectMobile', () => {
    const ghost = putMob(0x6001, 100, 100);
    ghost.ghost = true; ghost.hp = 0;
    // Audit #39 P1 #3 — resurrection now requires `target.client`
    // (must be a player) to prevent cross-map ghost-res of random
    // NPCs. The ghost in this test is a stand-in for a real player.
    ghost.client = { sendSystemMessage: () => {}, send: () => {} };
    putReagents(world, caster, ['bloodmoss', 'garlic', 'ginseng']);
    api.targeting.request = (_s, cb) => cb({ serial: ghost.serial });
    cast('resurrection');
    // With a client present the spell now offers the 30-s accept
    // prompt instead of an instant res; simulate the accept hook.
    if (ghost._pendingResurrect) {
      api.corpse.resurrectMobile(world, ghost, caster);
      ghost._pendingResurrect = null;
    }
    expect(api._resurrected).toContain(ghost.serial);
    expect(ghost.ghost).toBe(false);
  });

  it('resurrection refuses to raise a living target', () => {
    const alive = putMob(0x6002, 100, 100);
    putReagents(world, caster, ['bloodmoss', 'garlic', 'ginseng']);
    api.targeting.request = (_s, cb) => cb({ serial: alive.serial });
    cast('resurrection');
    expect(api._resurrected).toHaveLength(0);
  });

  it('explosion schedules a delayed blast via status-effects', () => {
    vi.useFakeTimers();
    const v1 = putMob(0x7001, 100, 100);
    const v2 = putMob(0x7002, 99,  100);
    const v3 = putMob(0x7003, 105, 100); // out of blast radius
    putReagents(world, caster, ['bloodmoss', 'mandrake']);
    api.targeting.request = (_s, cb) => cb({ serial: v1.serial });
    cast('explosion');
    // Fuse effect exists and nothing damaged yet.
    expect(statusEffects.has(v1, 'explosion-fuse')).toBe(true);
    expect(api._damaged).toHaveLength(0);
    // Advance past the 3s fuse — tickAll lives under fake timers too.
    vi.setSystemTime(Date.now() + 4000);
    statusEffects.tickAll(world, Date.now());
    const hitSerials = api._damaged.map((d) => d.serial);
    expect(hitSerials).toContain(v1.serial);
    expect(hitSerials).toContain(v2.serial);
    expect(hitSerials).not.toContain(v3.serial);
    vi.useRealTimers();
  });
});
