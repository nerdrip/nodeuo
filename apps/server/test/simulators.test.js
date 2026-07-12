import { describe, expect, it } from 'vitest';
import { simulateCombat } from '../src/systems/combat-simulator.js';
import { LootRegistry } from '../src/world/loot.js';

describe('admin simulators', () => {
  it('combat simulation is deterministic and does not mutate live mobiles', () => {
    const attacker = { serial: 1, name: 'fighter', str: 100, dex: 100, stam: 100, skills: { 41: 100, 28: 100, 1: 100 } };
    const defender = { serial: 2, name: 'orc', hp: 80, hpMax: 80, armor: 20, skills: { 41: 60, 1: 30 } };
    const before = JSON.stringify({ attacker, defender });
    const first = simulateCombat(attacker, defender, { trials: 1000, seed: 42 });
    const second = simulateCombat(attacker, defender, { trials: 1000, seed: 42 });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(first.dps).toBeGreaterThan(0);
    expect(JSON.stringify({ attacker, defender })).toBe(before);
  });

  it('loot simulation reports nested probabilities without creating items', () => {
    const loot = new LootRegistry();
    loot.register({ name: 'nested', entries: [{ template: 'gold', amount: [5, 10] }] });
    loot.register({ name: 'boss', entries: [
      { table: 'nested', chance: 1 },
      { magicItem: { slot: 'weapon' }, chance: 0.5 },
    ] });
    let state = 1;
    const rng = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
    const result = loot.simulate('boss', { trials: 2000, rng });
    expect(result.ok).toBe(true);
    expect(result.drops.find((drop) => drop.key === 'template:gold')?.dropRate).toBe(1);
    const magic = result.drops.find((drop) => drop.key === 'magic:weapon');
    expect(magic.dropRate).toBeGreaterThan(0.45);
    expect(magic.dropRate).toBeLessThan(0.55);
  });
});
