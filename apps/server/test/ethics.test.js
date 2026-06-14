import { describe, it, expect } from 'vitest';
import * as ethics from '../src/systems/pvp/ethics.js';

function makeMob(over = {}) { return { fame: 0, karma: 0, ...over }; }

describe('ethics', () => {
  it('hero gate: needs 5000+ fame', () => {
    const lo = makeMob({ fame: 1000 });
    expect(ethics.join(lo, 'hero').ok).toBe(false);
    const hi = makeMob({ fame: 7000 });
    expect(ethics.join(hi, 'hero').ok).toBe(true);
    expect(ethics.alignmentOf(hi)).toBe('hero');
  });

  it('evil gate: needs <-5000 karma', () => {
    const peaceful = makeMob({ karma: 0 });
    expect(ethics.join(peaceful, 'evil').ok).toBe(false);
    const villain = makeMob({ karma: -7000 });
    expect(ethics.join(villain, 'evil').ok).toBe(true);
  });

  it('tier scales with ethicPower', () => {
    const m = makeMob({ fame: 9000 });
    ethics.join(m, 'hero');
    expect(ethics.tierOf(m).name).toBe('Initiate');
    ethics.awardPower(m, 250);
    expect(ethics.tierOf(m).name).toBe('Apprentice');
    ethics.awardPower(m, 200);
    expect(ethics.tierOf(m).name).toBe('Adept');
  });

  it('canEthicAttack only across alignments', () => {
    const a = makeMob({ fame: 9000 });
    const b = makeMob({ fame: 9000 });
    const c = makeMob({ karma: -9000 });
    ethics.join(a, 'hero');
    ethics.join(b, 'hero');
    ethics.join(c, 'evil');
    expect(ethics.canEthicAttack(a, b)).toBe(false);   // same side
    expect(ethics.canEthicAttack(a, c)).toBe(true);
    expect(ethics.canEthicAttack(makeMob(), c)).toBe(false); // unaligned can't ethic-attack
  });

  it('invokePower spends ethicPower + gates by tier', () => {
    const m = makeMob({ fame: 9000 });
    ethics.join(m, 'hero');
    // Fresh Initiate (0 power) → no-power before tier check.
    expect(ethics.invokePower(m, 'honor-strike').reason).toBe('no-power');
    ethics.awardPower(m, 250);                // → Apprentice
    const r = ethics.invokePower(m, 'honor-strike');
    expect(r.ok).toBe(true);
    expect(m.ethicPower).toBe(200);
    // Vehemence needs Lord (tier 4) — won't reach.
    ethics.awardPower(m, 100);                // total 300 → still Apprentice
    expect(ethics.invokePower(m, 'vehemence').reason).toBe('tier-too-low');
  });

  it('leave clears alignment + power', () => {
    const m = makeMob({ fame: 9000 });
    ethics.join(m, 'hero');
    ethics.awardPower(m, 100);
    expect(ethics.leave(m)).toBe(true);
    expect(ethics.alignmentOf(m)).toBeNull();
    expect(m.ethicPower).toBeUndefined();
  });
});
