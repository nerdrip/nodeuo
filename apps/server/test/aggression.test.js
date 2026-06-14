import { describe, it, expect } from 'vitest';
import { stamp, isInCombat, clear, sweepExpired } from '../src/aggression.js';

function mob(serial, opts = {}) {
  return { serial, name: `Mob${serial}`, ...opts };
}

describe('aggression / heat-of-battle', () => {
  it('stamps both attacker and victim with a 2-min window', () => {
    const a = mob(1); const v = mob(2);
    const before = Date.now();
    stamp({}, a, v);
    expect(a._combatUntil).toBeGreaterThan(before + 119_000);
    expect(v._combatUntil).toBeGreaterThan(before + 119_000);
  });

  it('isInCombat reflects the stamp', () => {
    const a = mob(1);
    expect(isInCombat(a)).toBe(false);
    stamp({}, a, mob(2));
    expect(isInCombat(a)).toBe(true);
    a._combatUntil = Date.now() - 1000;
    expect(isInCombat(a)).toBe(false);
  });

  it('refreshes the window on successive stamps', () => {
    const a = mob(1);
    stamp({}, a, mob(2));
    const t1 = a._combatUntil;
    // Wait a tiny bit and re-stamp — the new expiry must be >= old.
    a._combatUntil = t1 - 100;
    stamp({}, a, mob(2));
    expect(a._combatUntil).toBeGreaterThanOrEqual(t1);
  });

  it('clear resets the field', () => {
    const a = mob(1);
    stamp({}, a, mob(2));
    clear({}, a);
    expect(a._combatUntil).toBe(0);
    expect(isInCombat(a)).toBe(false);
  });

  it('sweepExpired clears lapsed mobs and returns count', () => {
    const world = { mobiles: new Map() };
    const a = mob(1); const b = mob(2); const c = mob(3);
    world.mobiles.set(1, a); world.mobiles.set(2, b); world.mobiles.set(3, c);
    a._combatUntil = Date.now() - 1000;     // expired
    b._combatUntil = Date.now() + 60_000;   // active
    // c has no combat field — should be skipped silently
    const cleared = sweepExpired(world);
    expect(cleared).toBe(1);
    expect(a._combatUntil).toBe(0);
    expect(b._combatUntil).toBeGreaterThan(Date.now());
    expect(c._combatUntil).toBeUndefined();
  });

  it('tolerates missing attacker/victim', () => {
    expect(() => stamp({}, null, null)).not.toThrow();
    expect(() => stamp({}, mob(1), null)).not.toThrow();
    expect(() => stamp({}, null, mob(2))).not.toThrow();
  });
});
