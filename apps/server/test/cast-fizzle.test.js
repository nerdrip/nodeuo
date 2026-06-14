// ServUO-style skill check on `[cast`. Below minSkill the spell always
// fizzles; above maxSkill it never does; in between it's linear. Reagents
// and mana are consumed either way (matches OSI: a low-skill mage who
// fizzles still loses the materials — that's what makes Magery worth
// training).

import { describe, it, expect, beforeEach } from 'vitest';
import registerCast from '../../scripts/src/commands/magic/cast.js';

function makeWorld() { return { items: new Map(), mobiles: new Map() }; }

function makeApi(world) {
  const cmds = new Map();
  return {
    world,
    log: () => {},
    templates: {
      get(n) {
        const ids = {
          'reagent-garlic': 3972, 'reagent-ginseng': 3977,
          'reagent-spider-silk': 3981, 'reagent-mandrake': 3974,
          'reagent-sulfurous-ash': 3980, 'reagent-black-pearl': 3962,
          'reagent-nightshade': 3973,
        };
        return ids[n] ? { itemId: ids[n] } : null;
      },
    },
    combat: {
      damage: (_w, t, d) => { t.hp = Math.max(0, (t.hp ?? 50) - d); },
      animate: () => {},
    },
    // Auto-self target so spells that switched to `needsTarget: true`
    // (Heal / Greater Heal) still resolve in fizzle-tests.
    targeting: { request: (state, cb) => cb?.({ serial: state.mobile.serial }) },
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
      register(c) { cmds.set(c.name, c); },
      unregister(n) { cmds.delete(n); },
    },
    _cmds: cmds,
  };
}

function stockReagents(world, parent) {
  const map = {
    'reagent-garlic': 3972, 'reagent-ginseng': 3977,
    'reagent-spider-silk': 3981, 'reagent-mandrake': 3974,
    'reagent-sulfurous-ash': 3980, 'reagent-black-pearl': 3962,
    'reagent-nightshade': 3973,
  };
  let n = 1;
  for (const id of Object.values(map)) {
    world.items.set(0x4000_0000 + n, {
      serial: 0x4000_0000 + n, itemId: id, parent, amount: 5,
    });
    n++;
  }
}

describe('[cast fizzle (Magery skill check)', () => {
  let world, api, mob, state;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerCast(api);
    mob = {
      serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
      hp: 1, hpMax: 60, mana: 50, manaMax: 50,
      skills: { 26: 0 },
      client: { send: () => {} },
    };
    world.mobiles.set(mob.serial, mob);
    const sysmsgs = [];
    state = { mobile: mob, sendSystemMessage: (m) => sysmsgs.push(m), _sysmsgs: sysmsgs };
    stockReagents(world, mob.serial);
  });

  function cast(name) {
    api._cmds.get('cast').run({ state, sender: mob }, [name]);
  }

  it('never fizzles when skill >= maxSkill', () => {
    mob.skills[26] = 100;          // way above heal's maxSkill (40)
    const original = Math.random;
    Math.random = () => 0;         // worst-case roll for fizzle = guaranteed fizzle if reachable
    try {
      cast('heal');
    } finally { Math.random = original; }
    expect(mob.hp).toBeGreaterThan(1);
    expect(state._sysmsgs.join(' ')).not.toMatch(/fizzle/i);
  });

  it('always fizzles when skill < minSkill (below the spell window)', () => {
    mob.skills[26] = 0;            // lightning needs minSkill 40
    const manaBefore = mob.mana;
    const original = Math.random;
    Math.random = () => 0.999;     // best-case roll, but should still fizzle
    try {
      cast('lightning');
    } finally { Math.random = original; }
    expect(state._sysmsgs.join(' ')).toMatch(/fizzle/i);
    // Mana and reagents are consumed even on fizzle (OSI behavior).
    expect(mob.mana).toBeLessThan(manaBefore);
  });

  it('consumes reagents on fizzle so a low-skill mage still pays for failure', () => {
    mob.skills[26] = 0;
    const garlic = [...world.items.values()].find((i) => i.itemId === 3972);
    const before = garlic.amount;
    const original = Math.random;
    Math.random = () => 0.5;       // 50% threshold; heal at skill 0 fizzles 100%
    try { cast('heal'); } finally { Math.random = original; }
    expect(state._sysmsgs.join(' ')).toMatch(/fizzle/i);
    expect(garlic.amount).toBe(before - 1);
  });
});
