import { describe, it, expect } from 'vitest';
import * as statusEffects from '../src/status-effects.js';
import animateDead from '../../scripts/src/spells/necro/animate-dead.js';
import exorcism from '../../scripts/src/spells/necro/exorcism.js';
import vampiricEmbrace from '../../scripts/src/spells/necro/vampiric-embrace.js';

function makeWorld() {
  return { items: new Map(), mobiles: new Map() };
}

function makeApi(world) {
  return {
    world,
    statusEffects,
    protocol: {
      EffectKind: { FromSource: 0, Moving: 1, Lightning: 2, Stationary: 3 },
      huedEffect: () => new Uint8Array([0xC0]),
      playSound: () => new Uint8Array([0x54]),
      mobileUpdate: () => new Uint8Array([0x20]),
      mobileMoving: () => new Uint8Array([0x77]),
    },
  };
}

function putMobile(world, fields) {
  const mob = {
    serial: fields.serial,
    x: fields.x ?? 1500,
    y: fields.y ?? 850,
    z: fields.z ?? 0,
    map: fields.map ?? 1,
    body: fields.body ?? 0x190,
    hue: fields.hue ?? 0,
    hp: fields.hp ?? 50,
    hpMax: fields.hpMax ?? 50,
    skills: fields.skills ?? {},
    ...fields,
  };
  world.mobiles.set(mob.serial, mob);
  return mob;
}

describe('Necromancy edge cases', () => {
  it('Exorcism banishes ghosts and undead but leaves living NPCs in place', () => {
    const world = makeWorld();
    const api = makeApi(world);
    const caster = putMobile(world, { serial: 0x1001, x: 1500, y: 850 });
    const ghost = putMobile(world, { serial: 0x2001, x: 1501, y: 850, ghost: true, hp: 0, client: {} });
    const skeleton = putMobile(world, { serial: 0x2002, x: 1502, y: 850, servuoClass: 'Skeleton' });
    const vendor = putMobile(world, { serial: 0x2003, x: 1503, y: 850, name: 'a provisioner' });
    const messages = [];

    exorcism.cast(api, {
      sender: caster,
      state: { sendSystemMessage: (msg) => messages.push(msg) },
    });

    expect(ghost).toMatchObject({ x: 1470, y: 843, z: 0, map: 1 });
    expect(skeleton).toMatchObject({ x: 1470, y: 843, z: 0, map: 1 });
    expect(vendor).toMatchObject({ x: 1503, y: 850, z: 0, map: 1 });
    expect(messages.at(-1)).toBe('Banished 2 undead to the nearest shrine.');
  });

  it('Exorcism uses the target facet shrine table, not a single hard-coded tile', () => {
    const world = makeWorld();
    const api = makeApi(world);
    const caster = putMobile(world, { serial: 0x1001, x: 1220, y: 474, map: 2 });
    const undead = putMobile(world, {
      serial: 0x2001,
      x: 1221,
      y: 474,
      map: 2,
      undead: true,
    });

    exorcism.cast(api, {
      sender: caster,
      state: { sendSystemMessage: () => {} },
    });

    expect(undead).toMatchObject({ x: 1222, y: 474, z: -17, map: 2 });
  });

  it('Vampiric Embrace restores body, hue and fire resist overlay on removal', () => {
    const world = makeWorld();
    const api = makeApi(world);
    const caster = putMobile(world, {
      serial: 0x1001,
      body: 0x191,
      hue: 0x123,
      skills: { 50: 100 },
    });

    vampiricEmbrace.cast(api, {
      sender: caster,
      state: { sendSystemMessage: () => {} },
    });

    expect(caster.body).toBe(0x191);
    expect(caster.hue).toBe(0x847E);
    expect(caster._resistOverlay.fire).toBe(-25);
    expect(caster._vampImmunePoison).toBe(true);

    statusEffects.remove(caster, 'vampiric-embrace', world);

    expect(caster.body).toBe(0x191);
    expect(caster.hue).toBe(0x123);
    expect(caster._resistOverlay).toBeNull();
    expect(caster._vampImmunePoison).toBe(false);
  });

  it('Vampiric Embrace refuses to overwrite an existing transformation slot', () => {
    const world = makeWorld();
    const api = makeApi(world);
    const caster = putMobile(world, {
      serial: 0x1001,
      body: 0x2ED,
      hue: 0x456,
      _origBody: 0x190,
      skills: { 50: 120 },
    });
    const messages = [];

    vampiricEmbrace.cast(api, {
      sender: caster,
      state: { sendSystemMessage: (msg) => messages.push(msg) },
    });

    expect(caster.body).toBe(0x2ED);
    expect(caster.hue).toBe(0x456);
    expect(caster._resistOverlay).toBeUndefined();
    expect(messages).toContain('You are already transformed.');
  });

  it('Animate Dead chooses the summoned creature from the corpse kind and consumes the corpse', () => {
    const world = makeWorld();
    const api = makeApi(world);
    const caster = putMobile(world, { serial: 0x1001, x: 500, y: 500, map: 1 });
    const corpse = {
      serial: 0x4001,
      itemId: 0x2006,
      x: 501,
      y: 500,
      z: 0,
      map: 1,
      _originalKind: 'dragon',
    };
    world.items.set(corpse.serial, corpse);
    const minions = [];
    api.ctx = {
      spawnFactory: (w, kind, loc) => {
        const minion = putMobile(w, { serial: 0x3001, kind, ...loc });
        minions.push(minion);
        return minion;
      },
    };
    api.ai = { attach: (mob, name, opts) => { mob.ai = { name, opts }; } };
    api.systems = { summons: { registerSummon: (_w, mob) => { mob._registeredSummon = true; } } };
    const messages = [];

    animateDead.cast(api, {
      sender: caster,
      state: { sendSystemMessage: (msg) => messages.push(msg) },
    });

    expect(minions).toHaveLength(1);
    expect(minions[0]).toMatchObject({
      kind: 'skeletal-dragon',
      controlMaster: caster.serial,
      summoned: true,
      _registeredSummon: true,
    });
    expect(world.items.has(corpse.serial)).toBe(false);
    expect(messages).toContain('A skeletal dragon rises to serve you.');
  });
});
