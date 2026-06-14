// `[bandage` — delayed heal driven through a fake script api. Uses vi.useFakeTimers
// so we can fast-forward past the 5s apply window without waiting real time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import registerBandage from '../../scripts/src/skills/bandage.js';

const BANDAGE_ITEM_ID = 3617;

function makeWorld() {
  return { items: new Map(), mobiles: new Map() };
}

function makeApi(world) {
  const cmds = new Map();
  // Track skill-award invocations so tests can assert training kicks in.
  // Callers in bandage.js destructure `api.combat.awardSkill` so we can't
  // rely on `this` inside the fake — close over the array instead.
  const awards = [];
  const updates = [];
  return {
    world,
    log: () => {},
    templates: { get: (n) => (n === 'bandage' ? { itemId: BANDAGE_ITEM_ID } : null) },
    combat: {
      _awards: awards,
      awardSkill: (mob, id, difficulty) => {
        awards.push({ serial: mob.serial, id, difficulty });
      },
    },
    targeting: { request: () => {} },
    protocol: {
      healthUpdate: (e) => new Uint8Array([0xA1, e.serial & 0xff]),
      removeEntity: (s) => new Uint8Array([0x1D, s & 0xff]),
      containerContentUpdate: (e, parent) => {
        updates.push({ entry: e, parent });
        return new Uint8Array([0x25, e.serial & 0xff]);
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

function putBandage(world, parentSerial, amount) {
  const serial = 0x4000_0000 + world.items.size + 1;
  world.items.set(serial, {
    serial, itemId: BANDAGE_ITEM_ID, parent: parentSerial,
    amount, x: 0, y: 0, z: 0, map: 1,
  });
  return serial;
}

function putEnhancedBandage(world, parentSerial, amount) {
  const serial = 0x4000_0000 + world.items.size + 1;
  world.items.set(serial, {
    serial,
    itemId: BANDAGE_ITEM_ID,
    hue: 0x08A5,
    parent: parentSerial,
    amount,
    x: 0,
    y: 0,
    z: 0,
    map: 1,
    tagId: 'enhanced-bandage',
    bandageHealingBonus: 10,
    servuoClass: 'EnhancedBandage',
    servuoClasses: ['EnhancedBandage', 'Bandage'],
  });
  return serial;
}

function putFirstAidBelt(world, mobSerial, fields = {}) {
  const serial = 0x4000_1000 + world.items.size + 1;
  world.items.set(serial, {
    serial,
    itemId: 0xA1F6,
    parent: mobSerial,
    layer: 12,
    amount: 1,
    x: 0,
    y: 0,
    z: 0,
    map: 1,
    script: 'first-aid-belt',
    firstAidBelt: true,
    firstAidMaxBandages: 1000,
    ...fields,
  });
  return serial;
}

describe('[bandage', () => {
  /** @type {ReturnType<typeof makeWorld>} */ let world;
  /** @type {ReturnType<typeof makeApi>} */   let api;
  /** @type {any} */ let mob;
  /** @type {any} */ let state;

  beforeEach(() => {
    vi.useFakeTimers();
    world = makeWorld();
    api = makeApi(world);
    registerBandage(api);
    const sent = [];
    // Healing 100, Anatomy 100 → always succeeds under the success-chance formula.
    mob = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      hp: 30, hpMax: 100,
      skills: { 18: 100, 2: 100 },
      client: { send: (b) => sent.push(b) },
      _sent: sent,
    };
    world.mobiles.set(mob.serial, mob);
    const sysmsgs = [];
    state = { mobile: mob, sendSystemMessage: (m) => sysmsgs.push(m), _sysmsgs: sysmsgs };
  });

  afterEach(() => { vi.useRealTimers(); });

  function bandage(arg) {
    api._cmds.get('bandage').run({ state, sender: mob }, arg ? [arg] : []);
  }

  it('consumes one bandage when applied to self', () => {
    const b = putBandage(world, mob.serial, 3);
    bandage('self');
    expect(world.items.get(b).amount).toBe(2);
  });

  it('finds bandages inside nested backpack containers', () => {
    const bag = {
      serial: 0x4000_1000,
      itemId: 0x0E76,
      parent: mob.serial,
      amount: 1,
      x: 0,
      y: 0,
      z: 0,
      map: 1,
    };
    world.items.set(bag.serial, bag);
    const b = putBandage(world, bag.serial, 3);

    bandage('self');

    expect(world.items.get(b).amount).toBe(2);
    expect(api._updates).toContainEqual(
      expect.objectContaining({
        parent: bag.serial,
        entry: expect.objectContaining({ serial: b, amount: 2 }),
      }),
    );
  });

  it('heals after the ~5s apply timer and awards skill', () => {
    putBandage(world, mob.serial, 1);
    const hpBefore = mob.hp;
    bandage('self');
    expect(mob.hp).toBe(hpBefore);
    // Audit #43 P2-7 — bandage timer now scales with DEX. Self-heal at
    // default DEX=50 takes ~9s (`ceil(11 - dex/20)` capped 4..8). Bump
    // the advance to cover the worst-case 8s window.
    vi.advanceTimersByTime(10000);
    expect(mob.hp).toBeGreaterThan(hpBefore);
    // Both Healing (18) and Anatomy (2) should have been rewarded on success.
    const ids = api.combat._awards.map((a) => a.id);
    expect(ids).toContain(18);
    expect(ids).toContain(2);
  });

  it('prefers EnhancedBandage and applies its ServUO healing bonus', () => {
    putBandage(world, mob.serial, 1);
    putEnhancedBandage(world, mob.serial, 1);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      bandage('self');
      vi.advanceTimersByTime(10000);
    } finally {
      randomSpy.mockRestore();
    }

    expect(mob.hp).toBe(71);
    expect([...world.items.values()].some((it) => it.servuoClass === 'EnhancedBandage')).toBe(false);
    expect([...world.items.values()].some((it) => it.itemId === BANDAGE_ITEM_ID && it.amount === 1)).toBe(true);
  });

  it('uses bandages stored in an equipped FirstAidBelt and applies belt healing bonus', () => {
    const belt = putFirstAidBelt(world, mob.serial, {
      servuoClass: 'KhaldunFirstAidBelt',
      firstAidHealingBonus: 10,
    });
    const b = putBandage(world, belt, 1);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      bandage('self');
      vi.advanceTimersByTime(10000);
    } finally {
      randomSpy.mockRestore();
    }

    expect(world.items.has(b)).toBe(false);
    expect(mob.hp).toBe(71);
  });

  it('refuses to start a second bandage while one is in progress', () => {
    const b = putBandage(world, mob.serial, 3);
    bandage('self');
    // Attempt #2 while busy — should be rejected and NOT burn another bandage.
    bandage('self');
    expect(world.items.get(b).amount).toBe(2);
    expect(state._sysmsgs.some((m) => /already/i.test(m))).toBe(true);
  });

  it('rejects when no bandages are in the backpack', () => {
    bandage('self');
    expect(state._sysmsgs.some((m) => /no clean bandages/i.test(m))).toBe(true);
  });

  it('rejects when the target is already at full HP', () => {
    putBandage(world, mob.serial, 1);
    mob.hp = mob.hpMax;
    bandage('self');
    // Audit #43 P2-7 — bandage timer now scales with DEX. Self-heal at
    // default DEX=50 takes ~9s (`ceil(11 - dex/20)` capped 4..8). Bump
    // the advance to cover the worst-case 8s window.
    vi.advanceTimersByTime(10000);
    expect(state._sysmsgs.some((m) => /not in need/i.test(m))).toBe(true);
  });

  it('can heal another mobile via targeting', () => {
    putBandage(world, mob.serial, 1);
    // Scratch wound (only 5 HP missing) → low difficulty, guaranteed success
    // under the skill-check formula given 100 Healing / 100 Anatomy.
    const patient = {
      serial: 0x2002, x: 100, y: 100, z: 0, map: 1,
      hp: 75, hpMax: 80, skills: {},
    };
    world.mobiles.set(patient.serial, patient);
    api.targeting.request = (_s, cb) => cb({ serial: patient.serial });
    bandage();
    // Audit #43 P2-7 — bandage timer now scales with DEX. Self-heal at
    // default DEX=50 takes ~9s (`ceil(11 - dex/20)` capped 4..8). Bump
    // the advance to cover the worst-case 8s window.
    vi.advanceTimersByTime(10000);
    expect(patient.hp).toBeGreaterThan(75);
  });

  it('cures poisoned patients with the ServUO healing threshold', () => {
    putBandage(world, mob.serial, 1);
    const patient = {
      serial: 0x2003, x: 100, y: 100, z: 0, map: 1,
      hp: 80, hpMax: 80,
      poisoned: true, poisonLevel: 1,
    };
    world.mobiles.set(patient.serial, patient);
    api.targeting.request = (_s, cb) => cb({ serial: patient.serial });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      bandage();
      vi.advanceTimersByTime(10000);
    } finally {
      randomSpy.mockRestore();
    }

    expect(patient.poisoned).toBe(false);
    expect(patient.poisonLevel).toBe(0);
    expect(state._sysmsgs).toContain('You cure them of poison.');
  });

  it('stanches bleeding before falling through to normal healing', () => {
    putBandage(world, mob.serial, 1);
    const patient = {
      serial: 0x2004, x: 100, y: 100, z: 0, map: 1,
      hp: 80, hpMax: 80,
      _bleedUntil: Date.now() + 30_000,
      _bleedDmg: 4,
    };
    world.mobiles.set(patient.serial, patient);
    api.targeting.request = (_s, cb) => cb({ serial: patient.serial });

    bandage();
    vi.advanceTimersByTime(10000);

    expect(patient._bleedUntil).toBe(0);
    expect(state._sysmsgs).toContain('You staunch the bleeding.');
  });

  it('resurrects a dead patient when Healing and Anatomy are high enough', () => {
    putBandage(world, mob.serial, 1);
    const patient = {
      serial: 0x2005, x: 100, y: 100, z: 0, map: 1,
      name: 'a fallen ally',
      hp: 0, hpMax: 80,
      ghost: true,
    };
    world.mobiles.set(patient.serial, patient);
    api.targeting.request = (_s, cb) => cb({ serial: patient.serial });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      bandage();
      vi.advanceTimersByTime(10000);
    } finally {
      randomSpy.mockRestore();
    }

    expect(patient.ghost).toBe(false);
    expect(patient.hp).toBeGreaterThan(0);
    expect(state._sysmsgs).toContain('You revive a fallen ally.');
  });
});
