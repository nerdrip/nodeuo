import { describe, expect, it } from 'vitest';
import { RegionRegistry } from '../src/regions.js';
import { classifyRegion, encounterSpawnPoint } from '../../scripts/src/spawns/random-encounters.js';

function mob(x, y, map = 1) {
  return { x, y, map };
}

describe('random encounter region safety', () => {
  it('never allows encounters in guarded towns, even below a forest region', () => {
    const regions = new RegionRegistry();
    regions.register({
      name: 'Moonglow Forest', map: 1, type: 'base', priority: 1,
      rects: [{ x1: 0, y1: 0, x2: 200, y2: 200 }],
    });
    regions.register({
      name: 'Moonglow', map: 1, type: 'town', priority: 10,
      rects: [{ x1: 40, y1: 40, x2: 160, y2: 160 }],
    });

    expect(classifyRegion({ regions }, mob(100, 100))).toBeNull();
  });

  it('classifies eligible wilderness themes through the live api.regions field', () => {
    const regions = new RegionRegistry();
    regions.register({
      name: 'Yew Forest', map: 1, type: 'base',
      rects: [{ x1: 0, y1: 0, x2: 200, y2: 200 }],
    });
    regions.register({
      name: 'Old Graveyard', map: 1, type: 'base', priority: 5,
      rects: [{ x1: 80, y1: 80, x2: 120, y2: 120 }],
    });

    expect(classifyRegion({ regions }, mob(20, 20))).toBe('forest');
    expect(classifyRegion({ regions }, mob(100, 100))).toBe('graveyard');
  });

  it('uses wilderness only when no registered region owns the tile', () => {
    const regions = new RegionRegistry();
    expect(classifyRegion({ regions }, mob(500, 500))).toBe('wilderness');
  });

  it('never offsets an automatic encounter across a guarded city boundary', () => {
    const regions = new RegionRegistry();
    regions.register({
      name: 'Border Town', map: 1, type: 'town',
      rects: [{ x1: 0, y1: -20, x2: 20, y2: 20 }],
    });
    const rolls = [0, 0, 0.5, 0]; // east into town, then west into wilderness
    let index = 0;
    const point = encounterSpawnPoint(
      { regions }, mob(-1, 0), 'wilderness',
      () => rolls[index++] ?? 0.5,
    );
    expect(point).toMatchObject({ x: -5, y: 0, map: 1 });
    expect(classifyRegion({ regions }, point)).toBe('wilderness');
  });
});
