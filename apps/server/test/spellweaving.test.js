import { describe, it, expect } from 'vitest';
import {
  manaCostFor, recordSpellweavingCast, applyArcaneFocus,
} from '../src/systems/spellweaving.js';

describe('spellweaving combo', () => {
  it('first cast pays base cost', () => {
    const m = {};
    expect(manaCostFor(m, 20)).toBe(20);
  });

  it('combo charges add 5 mana per cast within window', () => {
    const m = {};
    recordSpellweavingCast(m);
    expect(manaCostFor(m, 20)).toBe(25);  // +5
    recordSpellweavingCast(m);
    expect(manaCostFor(m, 20)).toBe(30);  // +10
    recordSpellweavingCast(m);
    expect(manaCostFor(m, 20)).toBe(35);  // +15
  });

  it('caps at 5 charges', () => {
    const m = {};
    for (let i = 0; i < 10; i++) recordSpellweavingCast(m);
    expect(m._weavingCombo).toBe(5);
    expect(manaCostFor(m, 20)).toBe(20 + 5 * 5);
  });

  it('Arcane Focus reduces cost', () => {
    const m = {};
    applyArcaneFocus(m, 4 /* level */, 5_000);
    // 4-level focus = -20% (5% per level).
    expect(manaCostFor(m, 50)).toBe(40);
  });

  it('Arcane Focus + combo stack independently', () => {
    const m = {};
    applyArcaneFocus(m, 2, 5_000);
    recordSpellweavingCast(m); // combo 1
    // base 20 → -10% from focus = 18 → +5 combo = 23
    expect(manaCostFor(m, 20)).toBe(23);
  });

  it('focus expires after duration', async () => {
    const m = {};
    applyArcaneFocus(m, 4, 30); // 30ms
    await new Promise((r) => setTimeout(r, 50));
    expect(manaCostFor(m, 50)).toBe(50);
  });
});
