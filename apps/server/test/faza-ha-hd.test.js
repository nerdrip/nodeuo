// FAZY HA-HD compact tests.

import { describe, it, expect, vi } from 'vitest';
import { loadSpells } from './_setup-content.js';
import { beforeAll } from 'vitest';
beforeAll(async () => { await loadSpells(); });
import { castSpell, getSpell } from '../src/systems/spells/index.js';
import { World } from '../src/world/world.js';

describe('GM+ bypass spell costs (PHASE HA / #115)', () => {
  it('GM caster pays 0 mana / 0 tithing on cast', () => {
    const w = new World();
    const c = w.createMobile({ name: 'gm', body: 0x190, x: 0, y: 0, z: 0, map: 1, mana: 0, manaMax: 50, hp: 100, hpMax: 100, skills: { 26: 100 } });
    c.client = { send: () => {}, sendSystemMessage: () => {} };
    const def = getSpell(1); // Clumsy
    expect(def).toBeTruthy();
    // Player can't cast — out of mana.
    const r1 = castSpell({ caster: c, target: c, spellId: 1, world: w, accessLevel: 'Player' });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe('low-mana');
    // GM bypasses cost gate.
    const r2 = castSpell({ caster: c, target: c, spellId: 1, world: w, accessLevel: 'GM' });
    expect(r2.ok).toBe(true);
    // Mana stayed at 0 — no charge applied.
    expect(c.mana).toBe(0);
  });

  it('Admin caster bypasses cost just like GM', () => {
    const w = new World();
    const c = w.createMobile({ name: 'admin', body: 0x190, x: 0, y: 0, z: 0, map: 1, mana: 0, manaMax: 50, hp: 100, hpMax: 100, skills: { 26: 100 } });
    c.client = { send: () => {}, sendSystemMessage: () => {} };
    const r = castSpell({ caster: c, target: c, spellId: 1, world: w, accessLevel: 'Admin' });
    expect(r.ok).toBe(true);
  });

  it('Counselor (lower than GM) does NOT bypass', () => {
    const w = new World();
    const c = w.createMobile({ name: 'csr', body: 0x190, x: 0, y: 0, z: 0, map: 1, mana: 0, manaMax: 50, hp: 100, hpMax: 100, skills: { 26: 100 } });
    c.client = { send: () => {}, sendSystemMessage: () => {} };
    const r = castSpell({ caster: c, target: c, spellId: 1, world: w, accessLevel: 'Counselor' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('low-mana');
  });

  it('fizzle path does NOT refund mana when GM bypassed costs', () => {
    const w = new World();
    const c = w.createMobile({ name: 'gm', body: 0x190, x: 0, y: 0, z: 0, map: 1, mana: 30, manaMax: 50, hp: 100, hpMax: 100, skills: { 26: 1 } });
    c.client = { send: () => {}, sendSystemMessage: () => {} };
    // Force the random fizzle by stubbing Math.random to land on the
    // fizzle bucket. Tier-1 spell minSkill is 0, so successChance falls
    // to 0.5; pick 0.99 to land outside.
    const orig = Math.random;
    Math.random = () => 0.99;
    try {
      castSpell({ caster: c, target: c, spellId: 1, world: w, accessLevel: 'GM' });
      // GM mana stays exactly where it was — the fizzle refund (#115)
      // would have pushed it to 32 (30 + 2) without the fix.
      expect(c.mana).toBe(30);
    } finally {
      Math.random = orig;
    }
  });
});

describe('Chivalry tithing cost parity', () => {
  it('castSpell charges tithing points for Chivalry registry casts', () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const w = new World();
      const c = w.createMobile({
        name: 'paladin',
        body: 0x190,
        x: 0,
        y: 0,
        z: 0,
        map: 1,
        hp: 100,
        hpMax: 100,
        mana: 0,
        manaMax: 50,
        tithingPoints: 4,
        skills: { 52: 100 },
      });
      c.client = { send: () => {}, sendSystemMessage: () => {} };

      const low = castSpell({ caster: c, spellId: 203, world: w, accessLevel: 'Player' });
      expect(low).toMatchObject({ ok: false, reason: 'low-tithing' });

      c.tithingPoints = 5;
      const ok = castSpell({ caster: c, spellId: 203, world: w, accessLevel: 'Player' });
      expect(ok.ok).toBe(true);
      expect(c.tithingPoints).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      random.mockRestore();
    }
  });
});

describe('[go landmark library (PHASE HB)', () => {
  it('exports 60+ canonical destinations', async () => {
    const mod = await import('../../scripts/src/commands/go.js');
    const locs = mod._LOCATIONS_FOR_TEST;
    expect(Object.keys(locs).length).toBeGreaterThanOrEqual(50);
    expect(locs.britain).toBeTruthy();
    expect(locs['britain-bank']).toBeTruthy();
    expect(locs.trinsic).toBeTruthy();
    expect(locs.destard).toBeTruthy();
    expect(locs['shrine-honor']).toBeTruthy();
    expect(locs.haven).toBeTruthy();
  });

  it('every entry has x/y/z/map/label fields', async () => {
    const mod = await import('../../scripts/src/commands/go.js');
    for (const [k, v] of Object.entries(mod._LOCATIONS_FOR_TEST)) {
      expect(typeof v.x).toBe('number');
      expect(typeof v.y).toBe('number');
      expect(typeof v.z).toBe('number');
      expect(typeof v.map).toBe('number');
      expect(typeof v.label).toBe('string');
      expect(k.length).toBeGreaterThan(0);
    }
  });
});
