// PHASE CV — weapon special-abilities table sanity. Each ability ships
// with a label, mana cost, and onHit handler that returns a numeric
// damage bonus. Exercises the bonus path so a regression to a label-
// only entry would be caught.

import { describe, it, expect } from 'vitest';
import { _ABILITIES_FOR_TEST as ABILITIES } from '../../scripts/src/skills/wpn.js';

describe('weapon abilities (PHASE CV)', () => {
  it('every entry has label, mana cost, onHit handler', () => {
    for (const [slug, def] of Object.entries(ABILITIES)) {
      expect(typeof def.label).toBe('string');
      expect(typeof def.mana).toBe('number');
      expect(def.mana).toBeGreaterThan(0);
      expect(typeof def.onHit).toBe('function');
      void slug;
    }
  });

  it('armor-ignore returns positive damage bonus and applies it', () => {
    const mob = {
      serial: 1, hp: 100, hpMax: 100, mana: 50, manaMax: 50,
      client: { sendSystemMessage: () => {} },
    };
    const target = {
      serial: 2, hp: 100, hpMax: 100,
    };
    const bonus = ABILITIES['armor-ignore'].onHit({ mob, target, baseDamage: 20, ctx: {} });
    expect(bonus).toBeGreaterThan(0);
    expect(target.hp).toBeLessThan(100);
  });

  it('concussion-blow drains target mana on top of damage', () => {
    const mob = {
      serial: 1, hp: 100, hpMax: 100,
      client: { sendSystemMessage: () => {} },
    };
    const target = {
      serial: 2, hp: 100, hpMax: 100, mana: 30,
    };
    const bonus = ABILITIES['concussion-blow'].onHit({ mob, target, baseDamage: 20, ctx: {} });
    expect(bonus).toBeGreaterThan(0);
    expect(target.mana).toBe(20);   // -10 from concussion
    expect(target.hp).toBeLessThan(100);
  });
});
