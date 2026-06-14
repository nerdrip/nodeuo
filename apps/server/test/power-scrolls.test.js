import { describe, it, expect } from 'vitest';
import {
  createPowerScroll, eligibleScrollSkills,
} from '../src/systems/power-scrolls.js';

describe('power scroll skill ids', () => {
  it('labels canonical skill ids', () => {
    expect(createPowerScroll(32, 120).name).toContain('Archery');
    expect(createPowerScroll(58, 120).name).toContain('Throwing');
    expect(createPowerScroll(57, 120).name).toContain('Imbuing');
  });

  it('uses canonical champion reward tables', () => {
    expect(eligibleScrollSkills('coldblood')).toEqual([28, 41, 32, 6, 42, 44]);
    expect(eligibleScrollSkills('glade')).toEqual([26, 17, 30, 10, 23, 16]);
    expect(eligibleScrollSkills('abyss')).toEqual([26, 27, 17, 50, 52]);
  });
});
