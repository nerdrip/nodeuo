// FAZY FI-GM compact test sweep — covers the canonical wiring plus
// the new tools/commands shipped in this batch.

import { describe, it, expect } from 'vitest';
import { loadSpells } from './_setup-content.js';
import { beforeAll } from 'vitest';
beforeAll(async () => { await loadSpells(); });
import { World } from '../src/world/world.js';

describe('main.js wires nowych systems do api.systems (PHASE FI)', () => {
  it('boots without throwing — wiring smoke test', async () => {
    // Importing main.js with its side-effects (registerBoss, registerSigil,
    // registerCanonicalArenas) is too heavy for a unit test (it expects a
    // running TCP/WS listener). Smoke-test by importing the modules main
    // imports — if any has a typo, the import fails here.
    await import('../src/systems/economy/insurance.js');
    await import('../src/systems/slayers.js');
    await import('../src/systems/pvp/sigils.js');
    await import('../src/systems/bosses/world-bosses.js');
    // peerless arenas now live in scripts; verify the loader exists
    await import('../../scripts/src/systems/peerless-arenas.js');
    expect(true).toBe(true);
  });
});

describe('peerless arenas content registration (PHASE FT)', () => {
  it('peerless-arenas script registers 3 arenas', async () => {
    const peerless = await import('../src/systems/bosses/peerless.js');
    peerless._resetArenasForTest();
    const mod = await import('../../scripts/src/systems/peerless-arenas.js');
    await mod.default({ systems: { peerless }, log: () => {} });
    const list = peerless.listArenas();
    expect(list).toContain('travesty');
    expect(list).toContain('melisande');
    expect(list).toContain('effusion');
  });
});

describe('peerless mob templates (PHASE FU)', () => {
  it('Travesty/Lady Mel/Effusion all have boss + peerless flags', async () => {
    // Peerless templates merged into monsters.json on 2026-05-16 (see
    // tools/merge-templates-to-monsters.mjs). Source of truth is now
    // data/config/monsters.json; loaded by data.js into api.monsters.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mons = JSON.parse(fs.readFileSync(
      path.resolve(here, '..', '..', 'scripts', 'src', 'data', 'config', 'monsters.json'),
      'utf8',
    ));
    const byKind = new Map(mons.map((m) => [m.kind, m]));
    for (const kind of ['travesty', 'lady-mel', 'shimmering-effusion']) {
      const tpl = byKind.get(kind);
      expect(tpl).toBeTruthy();
      expect(tpl.boss).toBe(true);
      expect(tpl.peerless).toBe(true);
    }
  });
});

describe('weapons set runtime descriptor (PHASE FN)', () => {
  it('bow templates carry range:8 + ammoId 0x0F3F', async () => {
    const itemReg = await import('../src/content/items/registry.js');
    const mod = await import('../../scripts/src/items/definitions/weapons.js');
    await mod.default({ catalog: { items: itemReg }, log: () => {} });
    const bow = itemReg.getItem(0x13B2);
    expect(bow.weapon).toBeTruthy();
    expect(bow.weapon.skill).toBe(32);
    expect(bow.weapon.range).toBe(8);
    expect(bow.weapon.ammoId).toBe(0x0F3F);
  });

  it('crossbow uses bolts (0x1BFB) instead of arrows', async () => {
    const { getItem } = await import('../src/content/items/registry.js');
    const xbow = getItem(0x0F50);
    expect(xbow.weapon.ammoId).toBe(0x1BFB);
  });

  it('melee weapons get range:1 + ammoId:null', async () => {
    const { getItem } = await import('../src/content/items/registry.js');
    const sword = getItem(0x0F51); // Dagger
    expect(sword.weapon.range).toBe(1);
    expect(sword.weapon.ammoId).toBe(null);
  });

  it('throwing weapon templates use Throwing skill', async () => {
    const itemReg = await import('../src/content/items/registry.js');
    const mod = await import('../../scripts/src/items/definitions/weapons-extra.js');
    await mod.default({ catalog: { items: itemReg }, log: () => {} });
    const boomerang = itemReg.getItem(0x4068);
    expect(boomerang.weapon.skill).toBe(58);
  });
});

describe('Magic Lock + Magic Trap (PHASE GL)', () => {
  it('Magic Lock sets locked + lockDifficulty on a container', async () => {
    const { getSpell } = await import('../src/systems/spells/index.js');
    const w = new World();
    const caster = w.createMobile({ name: 'm', body: 0x190, x: 0, y: 0, z: 0, map: 1, mana: 100, manaMax: 100, hp: 100, hpMax: 100, skills: { 26: 100 } });
    caster.client = { send: () => {}, sendSystemMessage: () => {} };
    const def = getSpell(19);
    expect(def?.name).toBe('Magic Lock');
    const target = { itemId: 0x9AB, locked: false };
    // Run effect directly (skip cast pipeline to avoid setTimeout).
    def.effect({ caster, target, world: w });
    expect(target.locked).toBe(true);
    expect(target.lockDifficulty).toBe(60);
  });
});
