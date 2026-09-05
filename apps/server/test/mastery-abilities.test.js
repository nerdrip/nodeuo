import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { invokeMastery } from '../src/systems/mastery-abilities.js';
import { applyPoison } from '../src/poison.js';
import { apply as applyEffect, has as hasEffect, remove as removeEffect } from '../src/status-effects.js';
import { echoConduitDamage } from '../../scripts/src/spells/_helpers.js';

describe('mastery abilities', () => {
  it('SummonReaper creates a controlled temporary summon instead of a flag-only marker', () => {
    const world = new World();
    const caster = world.createMobile({
      x: 100,
      y: 100,
      z: 0,
      map: 1,
      mana: 100,
      manaMax: 100,
    });

    const result = invokeMastery(world, caster, null, 'SummonReaper');

    expect(result.ok).toBe(true);
    expect(caster.mana).toBe(35);
    expect(caster._reaperUntil).toBeGreaterThan(Date.now());
    const reaper = [...world.mobiles.values()].find((m) => m.kind === 'summoned-reaper');
    expect(reaper).toBeTruthy();
    expect(reaper).toMatchObject({
      controlMaster: caster.serial,
      summoned: true,
      summonedBy: caster.serial,
      ai: 'pet',
    });
    expect(reaper.summonedUntil).toBeGreaterThan(Date.now());
    expect(world._summons?.has(reaper.serial)).toBe(true);
  });

  it('rejects a missing harmful target before charging mana', () => {
    const world = new World();
    const caster = world.createMobile({ mana: 100, manaMax: 100 });

    expect(invokeMastery(world, caster, null, 'InjectedStrike')).toMatchObject({
      ok: false, reason: 'target-required',
    });
    expect(caster.mana).toBe(100);
  });

  it('InjectedStrike uses the central poison ticker', () => {
    const world = new World();
    const caster = world.createMobile({ mana: 100, manaMax: 100, hp: 100, hpMax: 100 });
    const target = world.createMobile({ hp: 100, hpMax: 100 });

    expect(invokeMastery(world, caster, target, 'InjectedStrike').ok).toBe(true);
    expect(target.poisoned).toBe(true);
    expect(hasEffect(target, 'poison')).toBe(true);
    expect(target._poisonExpiresAt).toBeGreaterThan(Date.now());
  });

  it('Rejuvinate restores vitals and cleanses debuffs without deleting buffs', () => {
    const world = new World();
    const caster = world.createMobile({ mana: 100, manaMax: 100 });
    const target = world.createMobile({
      hp: 10, hpMax: 100, mana: 10, manaMax: 100, stam: 10, stamMax: 100,
    });
    applyPoison(target, 2, caster);
    applyEffect(target, { name: 'paralyze', durationMs: 30_000 });
    applyEffect(target, { name: 'bless', durationMs: 30_000 });
    target._mortalStrikeUntil = Date.now() + 30_000;

    expect(invokeMastery(world, caster, target, 'Rejuvinate').ok).toBe(true);
    expect(target).toMatchObject({ hp: 40, mana: 40, stam: 40, poisoned: false });
    expect(hasEffect(target, 'poison')).toBe(false);
    expect(hasEffect(target, 'paralyze')).toBe(false);
    expect(hasEffect(target, 'bless')).toBe(true);
    expect(target._mortalStrikeUntil).toBe(0);
  });

  it('CommandUndead controls eligible AI temporarily and restores it on expiry', () => {
    const world = new World();
    const caster = world.createMobile({ mana: 100, manaMax: 100 });
    const undead = world.createMobile({ kind: 'undead-warrior', hp: 100, hpMax: 100 });
    undead.kind = 'undead-warrior';

    expect(invokeMastery(world, caster, undead, 'CommandUndead').ok).toBe(true);
    expect(undead).toMatchObject({ controlMaster: caster.serial, controlled: true, controlOrder: 'follow' });
    expect(removeEffect(undead, 'command-undead', world)).toBe(true);
    expect(undead.controlMaster).toBeNull();
    expect(undead.controlled).toBe(false);
  });

  it('Conduit echoes necromancy damage only inside its selected area', () => {
    const world = new World();
    const caster = world.createMobile({ x: 50, y: 50, map: 1, mana: 100, manaMax: 100, skills: { 49: 100, 33: 100 } });
    const primary = world.createMobile({ x: 60, y: 60, map: 1, hp: 100, hpMax: 100, notoriety: 3 });
    const nearby = world.createMobile({ x: 61, y: 60, map: 1, hp: 100, hpMax: 100, notoriety: 3 });
    const outside = world.createMobile({ x: 70, y: 70, map: 1, hp: 100, hpMax: 100, notoriety: 3 });
    const damage = (_world, target, amount) => { target.hp -= amount; };

    expect(invokeMastery(world, caster, { x: 60, y: 60, map: 1 }, 'Conduit').ok).toBe(true);
    expect(echoConduitDamage({ world, combat: { damage } }, caster, primary, 20)).toBe(1);
    expect(nearby.hp).toBeLessThan(100);
    expect(outside.hp).toBe(100);
  });
});
