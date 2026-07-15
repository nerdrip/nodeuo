import { describe, expect, it } from 'vitest';
import { castSpell } from '../src/systems/spells/index.js';
import { registerSpell } from '../src/systems/spells/registry.js';

function harness() {
  const world = { mobiles: new Map(), items: new Map() };
  const caster = {
    serial: 0x1001, x: 100, y: 100, z: 0, map: 1,
    hp: 100, mana: 100, manaMax: 100, skills: { 26: 120 },
    client: { send() {}, sendSystemMessage() {} },
  };
  world.mobiles.set(caster.serial, caster);
  return { world, caster };
}

function define(id, effect, extra = {}) {
  registerSpell({
    id, name: `Audit ${id}`, school: 'magery', skillId: 26,
    minSkill: 0, mana: 1, delayMs: 0, requiresTarget: true,
    effect, ...extra,
  });
}

describe('central spell target-kind validation', () => {
  it('executes location-target effects instead of looking for a fake mobile serial', () => {
    const { world, caster } = harness();
    let received = null;
    define(9901, ({ target }) => { received = target; });
    const tile = { x: 101, y: 100, z: 0, map: 1 };
    const result = castSpell({ caster, target: tile, world, spellId: 9901, accessLevel: 'Admin', instant: true });
    expect(result.ok).toBe(true);
    expect(received).toBe(tile);
  });

  it('accepts contained item targets and uses the owner position for range', () => {
    const { world, caster } = harness();
    const pack = { serial: 0x4001, parent: caster.serial, x: 80, y: 80, z: 0, map: 1 };
    const rune = { serial: 0x4002, parent: pack.serial, x: 150, y: 150, z: 0, map: 1, itemId: 0x1F14 };
    world.items.set(pack.serial, pack);
    world.items.set(rune.serial, rune);
    let received = null;
    define(9902, ({ target }) => { received = target; });
    const result = castSpell({ caster, target: rune, world, spellId: 9902, accessLevel: 'Admin', instant: true });
    expect(result.ok).toBe(true);
    expect(received).toBe(rune);
  });

  it('keeps dead mobile targets valid for Resurrection-style effects', () => {
    const { world, caster } = harness();
    const ghost = { serial: 0x2001, x: 100, y: 100, z: 0, map: 1, hp: 0, ghost: true };
    world.mobiles.set(ghost.serial, ghost);
    let fired = false;
    define(9903, () => { fired = true; });
    const result = castSpell({ caster, target: ghost, world, spellId: 9903, accessLevel: 'Admin', instant: true });
    expect(result.ok).toBe(true);
    expect(fired).toBe(true);
  });

  it('rejects remote cursor injection beyond the default spell range', () => {
    const { world, caster } = harness();
    let fired = false;
    define(9904, () => { fired = true; });
    const result = castSpell({
      caster, target: { x: 500, y: 500, z: 0, map: 1 },
      world, spellId: 9904, accessLevel: 'Admin', instant: true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(fired).toBe(false);
  });
});
