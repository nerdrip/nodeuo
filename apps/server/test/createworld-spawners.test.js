import { describe, expect, it } from 'vitest';
import { applyXmlSpawners } from '../../scripts/src/commands/admin/xmlload.js';

function fixture() {
  const groups = new Map();
  const world = {
    items: new Map(),
    mobiles: new Map(),
    _xmlSpawnersApplied: new Set(),
    _treasureChestsApplied: new Set(),
  };
  const spawner = {
    groups,
    add(group) { groups.set(group.id, group); return group; },
    remove(id) { groups.delete(id); },
  };
  return {
    world,
    spawner,
    api: {
      world,
      spawner,
      vendors: { hasKind: () => true },
      log() {},
    },
  };
}

describe('CreateWorld XmlSpawner restoration', () => {
  it('re-registers persisted vendor groups after runtime registry restart', () => {
    const f = fixture();
    const options = { facets: [1], fileFilter: 'vendors' };
    const first = applyXmlSpawners(f.api, options);
    expect(first.added).toBeGreaterThan(0);
    expect(f.spawner.groups.size).toBe(first.added);
    const persistedMarkers = f.world._xmlSpawnersApplied.size;

    // Persistence restores the marker Set, but Spawner.groups is not saved.
    f.spawner.groups.clear();
    const restored = applyXmlSpawners(f.api, options);
    expect(restored.added).toBe(first.added);
    expect(f.spawner.groups.size).toBe(first.added);
    expect(f.world._xmlSpawnersApplied.size).toBe(persistedMarkers);
  });
});

