import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { desiredAiForMob } from '../../scripts/src/npcs/ai/aggressive.js';
import { resolveItemType } from '../src/world/item-types.js';

const readConfig = (name) => JSON.parse(fs.readFileSync(
  new URL(`../../scripts/src/data/config/${name}`, import.meta.url),
  'utf8',
));

describe('gameplay data catalog audit', () => {
  it('defines one canonical row for each of the 58 classic skill ids', () => {
    const skills = readConfig('skills.json');
    expect(skills).toHaveLength(58);
    expect(skills.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 58 }, (_, index) => index + 1),
    );
    expect(new Set(skills.map((row) => row.name)).size).toBe(58);
  });

  it('maps every monster template onto an executable AI behavior', () => {
    const monsters = readConfig('monsters.json');
    const executable = new Set([
      'aggressive', 'animal', 'archer', 'berserk', 'mage', 'mystic',
      'necro', 'paladin', 'wander',
    ]);
    const unresolved = [];
    for (const template of monsters) {
      const desired = desiredAiForMob({ kind: template.kind }, template);
      if (!executable.has(desired)) unresolved.push(`${template.kind}:${desired}`);
    }
    expect(monsters).toHaveLength(803);
    expect(unresolved).toEqual([]);
  });

  it('keeps the extracted merchant economy structurally executable', () => {
    const vendors = readConfig('vendor-inventory.json');
    const unresolvedSellDescriptors = new Set();
    let inventoryRows = 0;
    for (const [kind, catalog] of Object.entries(vendors)) {
      expect(kind.length).toBeGreaterThan(0);
      for (const row of catalog.buy ?? []) {
        inventoryRows++;
        expect(row.type).toMatch(/^[A-Za-z0-9_]+$/);
        expect(row.price).toBeGreaterThan(0);
        expect(row.stock).toBeGreaterThan(0);
        expect(row.itemId).toBeGreaterThan(0);
        expect(row.itemId).toBeLessThanOrEqual(0xFFFF);
      }
      for (const row of catalog.sell ?? []) {
        inventoryRows++;
        expect(row.price).toBeGreaterThan(0);
        if (!resolveItemType(row.type)) unresolvedSellDescriptors.add(row.type);
      }
    }
    // PresetMapEntry is ServUO's pricing descriptor, not an item class.
    // Runtime intentionally skips it and continues to use concrete map rows.
    expect(Object.keys(vendors)).toHaveLength(85);
    expect(inventoryRows).toBe(2024);
    expect([...unresolvedSellDescriptors]).toEqual(['PresetMapEntry']);
  });
});
