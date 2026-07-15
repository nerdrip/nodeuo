import { describe, expect, it } from 'vitest';
import { ALL } from '../../scripts/src/spells/index.js';

const EXPECTED_SCHOOLS = {
  magery: 64,
  necromancy: 17,
  chivalry: 10,
  bushido: 6,
  ninjitsu: 8,
  spellweaving: 16,
  mysticism: 16,
  gargoyle: 1,
  mastery: 10,
  'bard-mastery': 7,
};

describe('spell catalog integrity', () => {
  it('loads every authored spell with unique ids/slugs and executable effects', () => {
    expect(ALL).toHaveLength(155);
    expect(new Set(ALL.map((spell) => spell.id)).size).toBe(ALL.length);
    expect(new Set(ALL.map((spell) => spell.slug)).size).toBe(ALL.length);
    for (const spell of ALL) {
      expect(spell.name).toBeTruthy();
      expect(spell.soundId).toBeTypeOf('number');
      expect(spell.cast).toBeTypeOf('function');
      expect(spell.mana).toBeGreaterThanOrEqual(0);
      if (spell.needsTarget) expect(['object', 'location']).toContain(spell.targetKind);
    }
  });

  it('keeps complete core-school counts stable', () => {
    const counts = Object.fromEntries(Object.keys(EXPECTED_SCHOOLS).map((school) => [
      school,
      ALL.filter((spell) => spell.school === school).length,
    ]));
    expect(counts).toEqual(EXPECTED_SCHOOLS);
  });
});
