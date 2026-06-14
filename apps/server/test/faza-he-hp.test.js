// FAZY HE-HP compact tests.

import { describe, it, expect, beforeEach } from 'vitest';
import { loadSpells } from './_setup-content.js';
import { beforeAll } from 'vitest';
beforeAll(async () => { await loadSpells(); });
import { getSpell } from '../src/systems/spells/index.js';
import { World } from '../src/world/world.js';
import {
  registerSigil, pickup, tickCorruption, _resetForTest,
} from '../src/systems/pvp/sigils.js';

describe('Magery Circle 3 missing spells (FAZA HJ / #124)', () => {
  it('Telekinesis (id 21) is registered', () => {
    expect(getSpell(21)?.name).toBe('Telekinesis');
  });

  it('Teleport (id 22) is registered', () => {
    expect(getSpell(22)?.name).toBe('Teleport');
  });

  it('Unlock (id 23) is registered', () => {
    expect(getSpell(23)?.name).toBe('Unlock');
  });

  it('Wall of Stone (id 24) is registered', () => {
    expect(getSpell(24)?.name).toBe('Wall of Stone');
  });

  it('Invisibility (id 44) effect sets hidden flag', () => {
    const w = new World();
    const c = w.createMobile({ name: 'm', body: 0x190, x: 0, y: 0, z: 0, map: 1, hp: 100, hpMax: 100, mana: 50, manaMax: 50, skills: { 26: 100 } });
    c.client = { send: () => {}, sendSystemMessage: () => {} };
    const def = getSpell(44);
    def.effect({ caster: c, world: w });
    expect(c.hidden).toBe(true);
    expect(c.stealthSteps).toBe(5);
  });

  it('Reveal (id 48) clears hidden flag on AOE', () => {
    const w = new World();
    const caster = w.createMobile({ name: 'c', body: 0x190, x: 100, y: 100, z: 0, map: 1, hp: 100, hpMax: 100, skills: { 26: 100 } });
    caster.client = { send: () => {}, sendSystemMessage: () => {} };
    const hidden = w.createMobile({ name: 'h', body: 0x190, x: 102, y: 100, z: 0, map: 1 });
    hidden.hidden = true;
    const def = getSpell(48);
    def.effect({ caster, world: w, target: { x: 100, y: 100 } });
    expect(hidden.hidden).toBe(false);
  });
});

describe('Polymorph form library (FAZA HI)', () => {
  it('exports 13 canonical forms', async () => {
    const mod = await import('../../scripts/src/commands/combat/polymorph.js');
    expect(Object.keys(mod._POLYMORPH_FORMS_FOR_TEST).length).toBe(13);
  });
});

describe('Sigil corruption broadcast (FAZA HM / #127)', () => {
  beforeEach(() => _resetForTest());

  it('tickCorruption fires broadcast callback per corrupted sigil', () => {
    registerSigil('britain', 100, 100, 1);
    pickup('britain', 0xAAAA, 0);
    const messages = [];
    tickCorruption(11 * 60 * 60_000, () => 'true-britannian', (msg) => messages.push(msg));
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('Britain');
    expect(messages[0]).toContain('true-britannian');
  });

  it('omits broadcast when no callback supplied (back-compat)', () => {
    registerSigil('minoc', 200, 200, 1);
    pickup('minoc', 0xBBBB, 0);
    expect(() => tickCorruption(11 * 60 * 60_000, () => 'shadowlords')).not.toThrow();
  });
});

describe('GM [set] command whitelist (FAZA HF / #120)', () => {
  it('exposes a hardened editable field allowlist', async () => {
    const mod = await import('../../scripts/src/commands/admin/set.js');
    const allow = mod._SET_ALLOWED_FIELDS_FOR_TEST;
    // Sample the canonical fields a GM session relies on most.
    expect(allow.has('hp')).toBe(true);
    expect(allow.has('hue')).toBe(true);
    expect(allow.has('locked')).toBe(true);
    expect(allow.has('paragon')).toBe(true);
    // Forbidden — refuse to expose internals like effects or _world.
    expect(allow.has('effects')).toBe(false);
    expect(allow.has('_world')).toBe(false);
  });
});
