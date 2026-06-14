import { describe, it, expect } from 'vitest';
import { RegionRegistry } from '../src/regions.js';

describe('RegionRegistry', () => {
  it('returns all regions containing a point', () => {
    const r = new RegionRegistry();
    r.register({ name: 'Britain', map: 1, rects: [{ x1: 0, y1: 0, x2: 100, y2: 100 }], guarded: true });
    r.register({ name: 'Bank', map: 1, rects: [{ x1: 10, y1: 10, x2: 20, y2: 20 }], noKill: true, guarded: true });
    const hits = r.at(1, 15, 15);
    expect(hits.map((h) => h.name)).toEqual(['Britain', 'Bank']);
    expect(r.primary(1, 15, 15).name).toBe('Bank');
    expect(r.isGuarded(1, 15, 15)).toBe(true);
  });

  it('ignores regions on other maps', () => {
    const r = new RegionRegistry();
    r.register({ name: 'Fel', map: 0, rects: [{ x1: 0, y1: 0, x2: 100, y2: 100 }] });
    expect(r.at(1, 50, 50)).toEqual([]);
  });
});
