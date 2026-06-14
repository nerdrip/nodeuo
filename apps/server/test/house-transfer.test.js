import { describe, it, expect } from 'vitest';
import { HouseRegistry } from '../src/systems/housing/houses.js';

function mob(serial, name) { return { serial, name }; }

describe('HouseRegistry.transferOwnership', () => {
  it('swaps the owner and refreshes touch', () => {
    const reg = new HouseRegistry();
    const a = mob(1, 'Alice');
    const b = mob(2, 'Bob');
    const h = reg.place(a, { x1: 0, y1: 0, x2: 5, y2: 5 });
    const before = h.lastTouchedAt;
    // Give the clock a tick so the lastTouchedAt comparison is meaningful.
    h.lastTouchedAt = before - 10_000;
    const ok = reg.transferOwnership(h, b);
    expect(ok).toBe(true);
    expect(h.ownerSerial).toBe(2);
    expect(h.ownerName).toBe('Bob');
    expect(h.lastTouchedAt).toBeGreaterThan(before - 10_000);
  });

  it('refuses no-op transfer (same owner)', () => {
    const reg = new HouseRegistry();
    const a = mob(1, 'Alice');
    const h = reg.place(a, { x1: 0, y1: 0, x2: 5, y2: 5 });
    expect(reg.transferOwnership(h, a)).toBe(false);
  });

  it('clears the new owner from any subordinate ACL slot', () => {
    const reg = new HouseRegistry();
    const a = mob(1, 'Alice');
    const b = mob(2, 'Bob');
    const h = reg.place(a, { x1: 0, y1: 0, x2: 5, y2: 5 });
    h.coowners.add(2);
    h.friends.add(2);
    expect(reg.transferOwnership(h, b)).toBe(true);
    expect(h.coowners.has(2)).toBe(false);
    expect(h.friends.has(2)).toBe(false);
  });

  it('housesOf reflects the new owner after transfer', () => {
    const reg = new HouseRegistry();
    const a = mob(1, 'Alice');
    const b = mob(2, 'Bob');
    const h = reg.place(a, { x1: 0, y1: 0, x2: 5, y2: 5 });
    expect(reg.housesOf(1)).toHaveLength(1);
    expect(reg.housesOf(2)).toHaveLength(0);
    reg.transferOwnership(h, b);
    expect(reg.housesOf(1)).toHaveLength(0);
    expect(reg.housesOf(2)).toHaveLength(1);
  });
});
