// FAZA BS — polymorph + bugfix #35 (body change must broadcast to nearby
// observers, not just the subject's own client).

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';
import * as statusEffects from '../src/status-effects.js';

function makeWorld() { return { items: new Map(), mobiles: new Map() }; }

function makeApi(world) {
  const cmds = new Map();
  const tpls = new Map();
  tpls.set('reagent-blood-moss',  { itemId: 3963 });
  tpls.set('reagent-mandrake',    { itemId: 3974 });
  tpls.set('reagent-spider-silk', { itemId: 3981 });
  return {
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
      mobileUpdate: () => new Uint8Array([0x20]),
      mobileMoving: (m) => {
        // Tag the body so the test can assert what shape the observer sees.
        const b = new Uint8Array([0x77, (m.body >> 8) & 0xff, m.body & 0xff]);
        return b;
      },
      removeEntity: (s) => new Uint8Array([0x1D, s & 0xff]),
      containerContentUpdate: () => new Uint8Array([0x25]),
      manaUpdate: () => new Uint8Array([0xA2]),
      healthUpdate: () => new Uint8Array([0xA1]),
    },
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    _cmds: cmds,
  };
}

function putReagents(world, caster) {
  const reagents = [3963, 3974, 3981];  // bloodmoss, mandrake, silk
  for (const itemId of reagents) {
    const serial = 0x4000_0000 + world.items.size + 1;
    world.items.set(serial, {
      serial, itemId, parent: caster.serial, amount: 10,
      x: 0, y: 0, z: 0, map: 1,
    });
  }
}

describe('polymorph (FAZA BS)', () => {
  /** @type {any} */ let api, world, caster, observer, observerSends;

  beforeEach(() => {
    world = makeWorld();
    observerSends = [];
    api = makeApi(world);
    registerCast(api);
    caster = {
      serial: 0x1001, body: 0x0190, x: 100, y: 100, z: 0, map: 1,
      direction: 0, hue: 0, flags: 0, notoriety: 1,
      hp: 100, hpMax: 100, mana: 80, manaMax: 80,
      skills: { 26: 120 },
      client: { send: () => {} },
    };
    observer = {
      serial: 0x2002, body: 0x0190, x: 102, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100,
      client: { send: (b) => observerSends.push(b) },
    };
    world.mobiles.set(caster.serial, caster);
    world.mobiles.set(observer.serial, observer);
  });

  function cast(name) {
    const state = { mobile: caster, sendSystemMessage: () => {} };
    api._cmds.get('cast').run({ state, sender: caster }, [name]);
  }

  it('changes the caster body to one of the polymorph forms', () => {
    putReagents(world, caster);
    cast('polymorph');
    expect(caster.body).not.toBe(0x0190);
    expect(caster._origBody).toBe(0x0190);
    expect(caster.polymorphed).toBe(true);
  });

  it('reverts to the original body on effect expiry', () => {
    putReagents(world, caster);
    cast('polymorph');
    statusEffects.remove(caster, 'polymorph');
    expect(caster.body).toBe(0x0190);
    expect(caster._origBody).toBeUndefined();
    expect(caster.polymorphed).toBe(false);
  });

  it('BUGFIX #35 — broadcasts the body change to nearby observers', () => {
    putReagents(world, caster);
    cast('polymorph');
    // Observer should have received a 0x77 packet whose body bytes match
    // the polymorphed body, not the original 0x0190 human.
    const moving = observerSends.find((b) => b[0] === 0x77);
    expect(moving).toBeTruthy();
    const body = (moving[1] << 8) | moving[2];
    expect(body).toBe(caster.body);     // observer sees the new form
    expect(body).not.toBe(0x0190);
  });

  it('BUGFIX #35 — broadcasts the revert to nearby observers', () => {
    putReagents(world, caster);
    cast('polymorph');
    observerSends.length = 0;
    statusEffects.remove(caster, 'polymorph');
    const moving = observerSends.find((b) => b[0] === 0x77);
    expect(moving).toBeTruthy();
    const body = (moving[1] << 8) | moving[2];
    expect(body).toBe(0x0190);          // observer sees human again
  });

  it('rejects double-polymorph (already transformed)', () => {
    putReagents(world, caster);
    cast('polymorph');
    const before = caster.body;
    putReagents(world, caster);
    cast('polymorph');
    expect(caster.body).toBe(before);   // no change second time
  });
});
