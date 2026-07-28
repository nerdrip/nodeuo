import { describe, it, expect } from 'vitest';
import {
  consumeScroll, createPowerScroll, createStatScroll, describeScrollEffect, eligibleScrollSkills,
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

  it('consumes modern absolute-cap and legacy relative-cap payloads', () => {
    const mob = { skillCaps: {} };
    const modern = { powerScroll: { skillId: 26, cap: 110 } };
    expect(describeScrollEffect(mob, modern)).toMatchObject({ current: 100, target: 110 });
    expect(consumeScroll(mob, modern)).toBe(true);
    expect(mob.skillCaps[26]).toBe(110);

    const legacy = { powerScroll: { skillId: 26, amount: 5 } };
    expect(describeScrollEffect(mob, legacy)).toMatchObject({ current: 110, target: 115 });
    expect(consumeScroll(mob, legacy)).toBe(true);
    expect(mob.skillCaps[26]).toBe(115);
  });

  it('supports stat scrolls and ignores transcendence payloads', () => {
    const mob = {};
    const stat = createStatScroll(10);
    expect(describeScrollEffect(mob, stat)).toMatchObject({ kind: 'stat', target: 235 });
    expect(consumeScroll(mob, stat)).toBe(true);
    expect(mob.statCap).toBe(235);
    expect(describeScrollEffect(mob, {
      powerScroll: { skill: 'Magery', value: 0.1, transcendence: true },
    })).toBeNull();
  });
});
