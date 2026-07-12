import { describe, expect, it } from 'vitest';
import { RegionRegistry } from '../src/regions.js';
import {
  regionDiagnostics, spawnerHeatmap, validateLootDraft, validateQuestDraft,
  validateRegionDraft, validateSpawnerDraft,
} from '../src/admin/world-authoring.js';

describe('validated world authoring', () => {
  it('normalizes region rectangles and detects priority-conflicting overlaps', () => {
    const regions = new RegionRegistry();
    const a = validateRegionDraft({ name: 'Town A', map: 1, type: 'town', rects: [{ x1: 20, y1: 20, x2: 10, y2: 10 }] });
    expect(a.ok).toBe(true);
    expect(a.value.rects[0]).toEqual({ x1: 10, y1: 10, x2: 20, y2: 20 });
    regions.upsert(a.value);
    regions.upsert(validateRegionDraft({ name: 'Town B', map: 1, type: 'town', rects: [{ x1: 18, y1: 18, x2: 30, y2: 30 }] }).value);
    const diagnostics = regionDiagnostics(regions);
    expect(diagnostics.overlaps).toHaveLength(1);
    expect(diagnostics.overlaps[0]).toMatchObject({ tiles: 9, priorityConflict: true });
    expect(regions.remove('Town A', 1)).toBe(1);
  });

  it('validates spawner kinds and produces capacity heatmap cells', () => {
    const draft = { id: 'rats:cave', map: 1, rect: { x1: 0, y1: 0, x2: 20, y2: 20 }, kinds: ['giant-rat'], maxCount: 5, respawnMs: [1000, 5000] };
    expect(validateSpawnerDraft(draft, ['giant-rat']).ok).toBe(true);
    expect(validateSpawnerDraft({ ...draft, kinds: ['horse-rat'] }, ['giant-rat']).warnings).toContain('unknown monster kind: horse-rat');
    const group = { ...draft, spawnedSerials: new Set([1, 2]) };
    const heat = spawnerHeatmap({ groups: new Map([[group.id, group]]) }, { mobiles: new Map() }, { map: 1, cellSize: 64 });
    expect(heat.cells[0]).toMatchObject({ groups: 1, capacity: 5, active: 2 });
  });

  it('rejects malformed loot outputs and broken quest dialogue links', () => {
    const loot = { get: () => null };
    expect(validateLootDraft(loot, { name: 'bad', entries: [{ itemId: 1, template: 'gold', chance: 2 }] }).ok).toBe(false);
    const quest = validateQuestDraft({
      id: 'lost-sword', name: 'Lost Sword',
      objectives: [{ kind: 'gather', target: 'sword', count: 1 }],
      dialog: { intro: { options: [{ reply: 'Yes', goto: 'missing' }] } },
    });
    expect(quest.ok).toBe(false);
    expect(quest.errors.join(' ')).toMatch(/missing node/);
  });
});
