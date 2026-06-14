// Bard skills — Discordance / Provocation / Peacemaking. Tests pin the
// timer field names + magnitudes the combat-formulas readers depend on.

import { describe, it, expect, vi } from 'vitest';
import {
  applyDiscordance, applyProvocation, applyPeacemaking,
  isPeaceful, isDiscorded, isProvoked, discordPenalty,
} from '../src/systems/bards/bard-skills.js';

const mkBard = (skills = {}) => ({
  serial: 1, name: 'bard', x: 0, y: 0, map: 1,
  skills: { 30: 100, 16: 100, 23: 100, 10: 100, ...skills },
});

const mkTarget = (overrides = {}) => ({
  serial: 2, name: 'mob', x: 1, y: 0, map: 1, fame: 0,
  skills: { 27: 0 },
  ...overrides,
});

describe('Discordance', () => {
  it('stamps _discordedUntil + _discordPenaltyPct on success', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const b = mkBard();
    const t = mkTarget();
    const r = applyDiscordance(null, b, t, null);
    expect(r.ok).toBe(true);
    expect(isDiscorded(t)).toBe(true);
    // Audit #31 P2 #8 — penalty = clamp(0.04..0.28, bardSkill/4/100).
    // Was a flat 0.30; ServUO `Discordance.cs` derives from skill.
    expect(discordPenalty(t)).toBe(0.25);
    // Cleanup: stop the per-target leash interval the new impl starts.
    clearInterval(t._discordLeashTimer);
    Math.random.mockRestore?.();
  });
  it('cooldown blocks rapid recasts', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const b = mkBard();
    const t = mkTarget();
    applyDiscordance(null, b, t, null);
    const second = applyDiscordance(null, b, mkTarget(), null);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('cooldown');
    Math.random.mockRestore?.();
  });
});

describe('Provocation', () => {
  it('cross-stamps _provokedTarget + _provokedUntil on both mobs', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const b = mkBard();
    const a = mkTarget({ serial: 10 });
    const c = mkTarget({ serial: 11 });
    const r = applyProvocation(null, b, a, c, null);
    expect(r.ok).toBe(true);
    expect(a._provokedTarget).toBe(c.serial);
    expect(c._provokedTarget).toBe(a.serial);
    expect(isProvoked(a)).toBe(true);
    expect(isProvoked(c)).toBe(true);
    Math.random.mockRestore?.();
  });
  it('refuses player targets', () => {
    const b = mkBard();
    const p = mkTarget({ client: {} });
    expect(applyProvocation(null, b, p, mkTarget({ serial: 99 }), null).ok).toBe(false);
  });
});

describe('Peacemaking', () => {
  it('stamps _peacefulUntil on a single target', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const b = mkBard();
    const t = mkTarget();
    const r = applyPeacemaking(null, b, null, { target: t });
    expect(r.ok).toBe(true);
    expect(isPeaceful(t)).toBe(true);
    Math.random.mockRestore?.();
  });
  it('clears _provokedTarget on calm', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const b = mkBard();
    const t = mkTarget({ _provokedTarget: 99 });
    applyPeacemaking(null, b, null, { target: t });
    expect(t._provokedTarget).toBeUndefined();
    Math.random.mockRestore?.();
  });
});
