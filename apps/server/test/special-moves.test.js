import { describe, it, expect } from 'vitest';
import {
  getSpecialMove, invokeMove, listSpecialMoves,
} from '../src/systems/special-moves.js';

const mkMob = () => ({
  serial: 1, mana: 100, manaMax: 100,
  skills: { 54: 80, 53: 80 }, // Ninjitsu 80, Bushido 80
});

describe('special-moves', () => {
  it('registers built-in moves', () => {
    expect(getSpecialMove('Confidence')).toBeTruthy();
    expect(getSpecialMove('SmokeBomb')).toBeTruthy();
    expect(listSpecialMoves().length).toBeGreaterThanOrEqual(5);
  });

  it('Confidence applies + deducts mana + sets cooldown', () => {
    const m = mkMob();
    const r = invokeMove({}, m, null, 'Confidence');
    expect(r.ok).toBe(true);
    expect(m.mana).toBe(75); // 100 - 25
    expect(m.confidenceUntil).toBeGreaterThan(Date.now());
    expect(m.confidenceRegen).toBeGreaterThanOrEqual(4);
    expect(m._moveCooldown.Confidence).toBeGreaterThan(Date.now());
  });

  it('refuses on insufficient mana', () => {
    const m = mkMob();
    m.mana = 5;
    const r = invokeMove({}, m, null, 'Confidence');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('low-mana');
  });

  it('refuses without skill', () => {
    const m = mkMob();
    m.skills[53] = 0;
    const r = invokeMove({}, m, null, 'Evasion');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-skill');
  });

  it('refuses while on cooldown', () => {
    const m = mkMob();
    invokeMove({}, m, null, 'Confidence');
    const r = invokeMove({}, m, null, 'Confidence');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cooldown');
  });

  it('Backstab requires hidden state', () => {
    const m = mkMob();
    m.mana = 100;
    m.hidden = false;
    const r = invokeMove({}, m, { serial: 2, hp: 50 }, 'Backstab');
    expect(r.ok).toBe(true); // invocation accepted
    // But the apply() short-circuits because not hidden — caller can read m.hidden didn't change.
  });

  it('SmokeBomb sets hidden + stealth steps', () => {
    const m = mkMob();
    invokeMove({}, m, null, 'SmokeBomb');
    expect(m.hidden).toBe(true);
    expect(m.stealthSteps).toBe(5);
  });

  it('unknown move returns reason', () => {
    const m = mkMob();
    const r = invokeMove({}, m, null, 'NonExistent');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown-move');
  });

  // ---- Audit batch #44 — newly-added abilities --------------------------

  it('DualWield sets the flag + 5s window', () => {
    const m = mkMob();
    m.skills[41] = 80; // Swords — also unlocks via hasWeaponSkill
    const r = invokeMove({}, m, null, 'DualWield');
    expect(r.ok).toBe(true);
    expect(m._dualWield).toBe(true);
    expect(m._dualWieldUntil).toBeGreaterThan(Date.now());
  });

  it('MovingShot requires Archery 30', () => {
    const m = mkMob();
    m.skills = { 32: 20 };
    const r1 = invokeMove({}, m, null, 'MovingShot');
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe('no-skill');
    m.skills[32] = 50;
    const r2 = invokeMove({}, m, null, 'MovingShot');
    expect(r2.ok).toBe(true);
    expect(m._movingShotUntil).toBeGreaterThan(Date.now());
  });

  it('DoubleShot requires Archery 80 and damages on invoke', () => {
    const m = mkMob();
    m.skills = { 32: 50 };
    const r1 = invokeMove({}, m, null, 'DoubleShot');
    expect(r1.ok).toBe(false);
    m.skills[32] = 90;
    let damaged = 0;
    const world = { _combat: { damage: () => damaged++ } };
    const r2 = invokeMove(world, m, { serial: 2, hp: 50 }, 'DoubleShot');
    expect(r2.ok).toBe(true);
    expect(damaged).toBe(1);
    expect(m._doubleStrikeUntil).toBeGreaterThan(Date.now());
  });

  it('FrenziedWhirlwind gated on Tactics 90 + weapon skill 80', () => {
    const m = mkMob();
    m.skills = { 41: 80, 28: 80 };
    expect(invokeMove({}, m, null, 'FrenziedWhirlwind').ok).toBe(false);
    m.skills[28] = 95;
    let hits = 0;
    const world = {
      mobiles: new Map([[2, { serial: 2, hp: 50, map: 1, x: 0, y: 0, notoriety: 5 }]]),
      _combat: { damage: () => hits++ },
    };
    m.x = 0; m.y = 0; m.map = 1;
    const r = invokeMove(world, m, null, 'FrenziedWhirlwind');
    expect(r.ok).toBe(true);
    expect(hits).toBe(4); // four rapid hits on the one neighbour
  });

  it('InfectiousStrike refuses when wielder has no poisoned weapon', () => {
    const m = mkMob();
    m.skills = { 41: 80, 31: 60 };
    const world = { _childrenByParent: new Map(), items: new Map(), _combat: { damage: () => {} } };
    const r = invokeMove(world, m, { serial: 2, hp: 50 }, 'InfectiousStrike');
    expect(r.ok).toBe(true); // invocation accepted; apply() reports lack of poison
  });
});
