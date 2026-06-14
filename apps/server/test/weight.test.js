import { describe, expect, it } from 'vitest';

import { maxWeight } from '../src/world/weight.js';

describe('maxWeight racial normalization', () => {
  it('treats legacy human race values as human', () => {
    expect(maxWeight({ str: 60, race: 'human' })).toBe(310);
    expect(maxWeight({ str: 60, race: 1 })).toBe(310);
    expect(maxWeight({ str: 60, race: 0 })).toBe(310);
    expect(maxWeight({ str: 60 })).toBe(310);
  });

  it('keeps non-human carrying capacity on string and numeric race values', () => {
    expect(maxWeight({ str: 60, race: 'elf' })).toBe(250);
    expect(maxWeight({ str: 60, race: 'gargoyle' })).toBe(250);
    expect(maxWeight({ str: 60, race: 2 })).toBe(250);
    expect(maxWeight({ str: 60, race: 3 })).toBe(250);
  });
});
