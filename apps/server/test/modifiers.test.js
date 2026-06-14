// Modifier-stack tests — SkillMod / StatMod / ResistanceMod.
import { describe, it, expect } from 'vitest';
import {
  addSkillMod, addStatMod, addResistanceMod,
  effectiveSkill, effectiveStat, effectiveResist,
  removeSkillMod, removeStatMod,
  tickModifiers,
} from '../src/world/modifiers.js';

const mkMob = () => ({
  skills: { 26: 70 },        // 70 Magery
  str: 50, dex: 50, int: 50,
  fireResist: 10, coldResist: 5, poisonResist: 0, energyResist: 0,
});

describe('modifiers', () => {
  it('adds and reads a relative skill mod', () => {
    const m = mkMob();
    addSkillMod(m, { name: 'bless-magery', skillId: 26, offset: 10 });
    expect(effectiveSkill(m, 26)).toBe(80);
  });

  it('replaces a skill mod by name (re-cast bless)', () => {
    const m = mkMob();
    addSkillMod(m, { name: 'bless', skillId: 26, offset: 5 });
    addSkillMod(m, { name: 'bless', skillId: 26, offset: 15 });
    expect(effectiveSkill(m, 26)).toBe(85);
  });

  it('absolute mod overrides base + ignores other relatives', () => {
    const m = mkMob();
    addSkillMod(m, { name: 'rel', skillId: 26, offset: 10, relative: true });
    addSkillMod(m, { name: 'abs', skillId: 26, offset: 100, relative: false });
    expect(effectiveSkill(m, 26)).toBe(100);
  });

  it('expires after duration', async () => {
    const m = mkMob();
    addSkillMod(m, { name: 'bless', skillId: 26, offset: 10, durationMs: 50 });
    expect(effectiveSkill(m, 26)).toBe(80);
    await new Promise((r) => setTimeout(r, 60));
    expect(effectiveSkill(m, 26)).toBe(70);
    tickModifiers(m);
    expect(m._skillMods.size).toBe(0);
  });

  it('stat mods sum and remove cleanly', () => {
    const m = mkMob();
    addStatMod(m, { name: 'bless', stat: 'str', offset: 10 });
    addStatMod(m, { name: 'haste', stat: 'str', offset: 5 });
    expect(effectiveStat(m, 'str')).toBe(65);
    removeStatMod(m, 'haste', 'str');
    expect(effectiveStat(m, 'str')).toBe(60);
  });

  it('resistance mods stack relative', () => {
    const m = mkMob();
    addResistanceMod(m, { name: 'arch-prot', kind: 'fire', offset: 20 });
    expect(effectiveResist(m, 'fire')).toBe(30);
    expect(effectiveResist(m, 'cold')).toBe(5);
  });

  it('removeSkillMod is a no-op when entry does not exist', () => {
    const m = mkMob();
    removeSkillMod(m, 'noop', 26);
    expect(effectiveSkill(m, 26)).toBe(70);
  });
});
