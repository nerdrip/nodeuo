// Consistency checks for the data-driven content registries. We read the
// JSON directly instead of going through the loader so the test is
// independent of @uo/server's script pipeline.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// `data/` was split into config/ (templates/source-of-truth) and
// world/ (placement data) on 2026-05-16. Every file this test reads
// is a config file.
const dataDir = path.resolve(here, '..', '..', 'scripts', 'src', 'data', 'config');
const worldDataDir = path.resolve(here, '..', '..', 'scripts', 'src', 'data', 'world');

const items = JSON.parse(fs.readFileSync(path.join(dataDir, 'items.json'), 'utf8'));
const lootTables = JSON.parse(fs.readFileSync(path.join(dataDir, 'loot-tables.json'), 'utf8'));
const monsters = JSON.parse(fs.readFileSync(path.join(dataDir, 'monsters.json'), 'utf8'));
const npcs = JSON.parse(fs.readFileSync(path.join(dataDir, 'npcs.json'), 'utf8'));
const skills = JSON.parse(fs.readFileSync(path.join(dataDir, 'skills.json'), 'utf8'));
const dungeonRevampBosses = JSON.parse(
  fs.readFileSync(path.join(worldDataDir, 'spawns', 'dungeon-revamp-bosses.json'), 'utf8'),
);
const questChains = JSON.parse(fs.readFileSync(path.join(worldDataDir, 'quest-chains.json'), 'utf8'));
const questRewardItems = JSON.parse(
  fs.readFileSync(path.join(worldDataDir, 'quest-reward-items.json'), 'utf8'),
);

describe('content data integrity', () => {
  it('every item has a unique name and valid itemId', () => {
    const names = new Set();
    for (const it of items) {
      expect(typeof it.name).toBe('string');
      expect(names.has(it.name)).toBe(false);
      names.add(it.name);
      expect(Number.isInteger(it.itemId)).toBe(true);
      expect(it.itemId).toBeGreaterThan(0);
      expect(it.itemId).toBeLessThan(0x10000);
    }
  });

  it('every loot table entry references an existing item template', () => {
    const itemNames = new Set(items.map((i) => i.name));
    const tableNames = new Set(lootTables.map((t) => t.name));
    for (const table of lootTables) {
      expect(Array.isArray(table.entries)).toBe(true);
      for (const e of table.entries) {
        if (e.template) expect(itemNames.has(e.template)).toBe(true);
        if (e.table) expect(tableNames.has(e.table)).toBe(true);
      }
    }
  });

  it('every monster references a loot table that exists', () => {
    const tableNames = new Set(lootTables.map((t) => t.name));
    const kinds = new Set();
    for (const m of monsters) {
      expect(typeof m.kind).toBe('string');
      expect(kinds.has(m.kind)).toBe(false);
      kinds.add(m.kind);
      // `loot` may be: undefined | string (table name) | array (inline
      // drop entries) | array of strings (multiple tables). spawnAggressive
      // handles all three forms; we only validate string references.
      if (typeof m.loot === 'string') {
        expect(tableNames.has(m.loot)).toBe(true);
      } else if (Array.isArray(m.loot)) {
        for (const entry of m.loot) {
          if (typeof entry === 'string') expect(tableNames.has(entry)).toBe(true);
        }
      }
      if (m.gold) {
        expect(Array.isArray(m.gold)).toBe(true);
        expect(m.gold.length).toBe(2);
        expect(m.gold[0]).toBeLessThanOrEqual(m.gold[1]);
      }
    }
  });

  it('dungeon-revamp encounter commands reference spawnable monster templates', () => {
    const kinds = new Set(monsters.map((m) => m.kind));
    const missing = [];
    for (const enc of dungeonRevampBosses.encounters ?? []) {
      const refs = [
        enc.boss?.kind,
        ...(enc.waves ?? []).flatMap((wave) => wave.kinds ?? []),
      ].filter(Boolean);
      for (const kind of refs) {
        if (!kinds.has(kind)) missing.push(`${enc.name}:${kind}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('scripted summons and boss adds reference spawnable monster templates', () => {
    const kinds = new Set(monsters.map((m) => m.kind));
    const refs = [
      // Necromancy Animate Dead table + fallback.
      'skeletal-mage',
      'bone-magi',
      'skeletal-dragon',
      'bone-knight',
      'ravager',
      'wraith',
      'rotting-corpse',
      'patchwork-skeleton',
      'skeleton',
      // Necromancy / Mysticism controlled summons.
      'vampire-bat-familiar',
      'death-adder',
      'dark-wolf-familiar',
      'horde-minion',
      'animated-weapon',
      // Unique boss mechanics.
      'imp',
      'parasitic-root',
      'gibberling',
      'harrower-tentacle',
    ];
    const missing = refs.filter((kind) => !kinds.has(kind));
    expect(missing).toEqual([]);
  });

  it('hire command roles have spawnable monster templates', () => {
    const kinds = new Set(monsters.map((m) => m.kind));
    const refs = [
      'hireling-warrior',
      'hireling-archer',
      'hireling-mage',
      'hireling-thief',
      'hireling-bard',
      'hireling-paladin',
      'hireling-beggar',
    ];
    const missing = refs.filter((kind) => !kinds.has(kind));
    expect(missing).toEqual([]);
  });

  it('audited quest chains and rewards keep their canonical ids', () => {
    const rewards = new Set(questRewardItems.map((r) => r.tag));
    expect(questChains['righting-wrong']).toBeTruthy();
    expect(questChains['righting-wrong-renowned']).toBeTruthy();
    expect(questChains['professional-bounty']).toBeTruthy();
    expect(questChains['professional-fisher']).toBeTruthy();
    expect(rewards.has('righting-wrong-title-deed')).toBe(true);
    expect(rewards.has('renowned-slayer-talisman')).toBe(true);
    expect(rewards.has('talisman-of-goblin-slaying')).toBe(true);
  });

  it('Righting Wrong quest chain references spawnable Wrong monsters', () => {
    const kinds = new Set(monsters.map((m) => m.kind));
    const wrong = questChains['righting-wrong'];
    const refs = (wrong?.stages ?? [])
      .flatMap((stage) => stage.objectives ?? [])
      .filter((obj) => obj.kind === 'slay')
      .map((obj) => obj.target);
    const missing = refs.filter((kind) => !kinds.has(kind));
    expect(missing).toEqual([]);
  });

  it('every npc has a unique kind and valid body', () => {
    const kinds = new Set();
    for (const n of npcs) {
      expect(typeof n.kind).toBe('string');
      expect(kinds.has(n.kind)).toBe(false);
      kinds.add(n.kind);
      expect(Number.isInteger(n.body)).toBe(true);
      expect(n.body).toBeGreaterThan(0);
    }
  });

  it('skills are well-formed and unique by id and name', () => {
    const ids = new Set();
    const names = new Set();
    const stats = new Set(['STR', 'DEX', 'INT']);
    for (const s of skills) {
      expect(Number.isInteger(s.id)).toBe(true);
      expect(s.id).toBeGreaterThan(0);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(names.has(s.name)).toBe(false);
      names.add(s.name);
      if (s.primary) expect(stats.has(s.primary)).toBe(true);
      if (s.secondary) expect(stats.has(s.secondary)).toBe(true);
    }
  });
});
