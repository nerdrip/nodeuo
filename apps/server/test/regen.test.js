// Resource regen tick — fractional accumulation + max-clamp + dead/ghost
// suppression. Wire updates aren't asserted here; that's a NetState concern.

import { describe, it, expect } from 'vitest';
import { regenTick } from '../src/regen.js';

function fakeWorld(mobs) {
  return { mobiles: new Map(mobs.map((m) => [m.serial ?? Math.random(), m])) };
}
const liveMob = (over = {}) => ({
  serial: 1, hp: 1, hpMax: 100,
  mana: 0, manaMax: 100,
  stam: 0, stamMax: 100,
  str: 50, dex: 50, int: 50,
  ...over,
});

describe('regenTick', () => {
  it('regenerates fractional amounts across multiple sub-second ticks', () => {
    // hpMax 200 → 2 HP/sec. 10 × 100ms = 1s should yield ~2 HP. The point
    // here is that the per-tick gain (0.2 HP) is fractional — without an
    // accumulator each tick would floor to 0 and HP would never move.
    const m = liveMob({ hp: 1, hpMax: 200 });
    const w = fakeWorld([m]);
    for (let i = 0; i < 10; i++) regenTick(w, 100);
    expect(m.hp).toBeGreaterThanOrEqual(3);
  });

  it('does not exceed hpMax', () => {
    const m = liveMob({ hp: 99, hpMax: 100 });
    regenTick(fakeWorld([m]), 60_000);
    expect(m.hp).toBe(100);
  });

  it('skips ghosts entirely', () => {
    const m = liveMob({ ghost: true, hp: 0, mana: 0, stam: 0 });
    regenTick(fakeWorld([m]), 60_000);
    expect(m.hp).toBe(0);
    expect(m.mana).toBe(0);
    expect(m.stam).toBe(0);
  });

  it('skips dead (HP<=0) mobiles even if not flagged ghost', () => {
    const m = liveMob({ hp: 0 });
    regenTick(fakeWorld([m]), 60_000);
    expect(m.hp).toBe(0);
  });

  it('Meditation skill speeds up mana regen', () => {
    const plain = liveMob({ serial: 1 });
    const med   = liveMob({ serial: 2, skills: { 47: 100 } });
    const w = fakeWorld([plain, med]);
    regenTick(w, 5_000);
    expect(med.mana).toBeGreaterThan(plain.mana);
  });

  it('does not update unrelated fields (no accidental mutation of body, name, etc.)', () => {
    const m = liveMob({ name: 'Alice', body: 0x190 });
    regenTick(fakeWorld([m]), 1_000);
    expect(m.name).toBe('Alice');
    expect(m.body).toBe(0x190);
  });
});
