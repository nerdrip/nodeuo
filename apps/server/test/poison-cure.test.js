// poison/cure end-to-end — poison spell attaches a DoT via statusEffects,
// cure removes it. Uses the real statusEffects module so we exercise the
// replace-on-name + tick + expiry paths.

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';
import * as statusEffects from '../src/status-effects.js';

function makeWorld() {
  return { items: new Map(), mobiles: new Map() };
}

function makeApi(world) {
  const cmds = new Map();
  const map = new Map();
  map.set('reagent-garlic',        { itemId: 3972 });
  map.set('reagent-ginseng',       { itemId: 3977 });
  map.set('reagent-nightshade',    { itemId: 3973 });
  return {
    world,
    log: () => {},
    templates: { get: (n) => map.get(n) },
    statusEffects,
    combat: {
      damage: (_w, t, d) => { t.hp = Math.max(0, (t.hp ?? 50) - d); },
      animate: () => {},
    },
    targeting: { request: () => {} },
    protocol: {
      EffectKind: { FromSource: 0, Moving: 1, Lightning: 2, Stationary: 3 },
      graphicalEffect: () => new Uint8Array([0x70]),
      huedEffect: () => new Uint8Array([0xC0]),
      playSound: () => new Uint8Array([0x54]),
      healthUpdate: () => new Uint8Array([0xA1]),
      manaUpdate: () => new Uint8Array([0xA2]),
      removeEntity: (s) => new Uint8Array([0x1D, (s >>> 24) & 0xff]),
      containerContentUpdate: (entry) => new Uint8Array([0x25, entry.serial & 0xff]),
    },
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    _cmds: cmds,
  };
}

function putReagent(world, parentSerial, itemId, amount) {
  const serial = 0x4000_0000 + world.items.size + 1;
  world.items.set(serial, {
    serial, itemId, parent: parentSerial,
    amount, x: 0, y: 0, z: 0, map: 1,
  });
  return serial;
}

describe('poison + cure spells', () => {
  /** @type {ReturnType<typeof makeWorld>} */ let world;
  /** @type {ReturnType<typeof makeApi>} */   let api;
  /** @type {any} */ let caster;
  /** @type {any} */ let victim;
  /** @type {any} */ let state;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerCast(api);
    const sent = [];
    caster = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, mana: 80, manaMax: 80,
      skills: { 26: 120 }, // Magery at cap → never fizzles.
      client: { send: (b) => sent.push(b) },
    };
    victim = {
      serial: 0x2002, x: 100, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, effects: [],
    };
    world.mobiles.set(caster.serial, caster);
    world.mobiles.set(victim.serial, victim);
    const sysmsgs = [];
    state = { mobile: caster, sendSystemMessage: (m) => sysmsgs.push(m), _sysmsgs: sysmsgs };
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: caster }, [name]);
  }

  it('poison attaches a DoT effect that ticks damage', () => {
    putReagent(world, caster.serial, 3973, 5); // nightshade
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('poison');
    expect(statusEffects.has(victim, 'poison')).toBe(true);
    // Walk 10 seconds of tick time — expect a few 2s ticks to fire and
    // damage the victim.
    const start = Date.now();
    for (let t = start; t <= start + 10_000; t += 500) {
      statusEffects.tickAll(world, t);
    }
    expect(victim.hp).toBeLessThan(100);
  });

  it('cure removes an active poison effect', () => {
    statusEffects.apply(victim, { name: 'poison', durationMs: 20_000, tickIntervalMs: 2000 });
    expect(statusEffects.has(victim, 'poison')).toBe(true);
    putReagent(world, caster.serial, 3972, 5); // garlic
    putReagent(world, caster.serial, 3977, 5); // ginseng
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('cure');
    expect(statusEffects.has(victim, 'poison')).toBe(false);
    expect(state._sysmsgs.some((m) => /cured/i.test(m))).toBe(true);
  });

  it('cure reports when there is nothing to cure', () => {
    putReagent(world, caster.serial, 3972, 5);
    putReagent(world, caster.serial, 3977, 5);
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('cure');
    expect(state._sysmsgs.some((m) => /no poison/i.test(m))).toBe(true);
  });

  it('re-casting equal-level poison does not stack a second effect', () => {
    // Audit #40 P1 #3 — the Poison spell now routes through the
    // canonical `applyPoison()` which mirrors ServUO's
    // "you are already poisoned by an equal strength" no-op. Was:
    // custom ticker that reset on every cast (let a 1-tick-left
    // poison be re-armed for 10 more ticks indefinitely).
    putReagent(world, caster.serial, 3973, 5);
    api.targeting.request = (_s, cb) => cb({ serial: victim.serial });
    cast('poison');
    cast('poison');
    expect(victim.effects).toHaveLength(1);
  });
});
