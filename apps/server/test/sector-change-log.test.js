import { describe, expect, it } from 'vitest';
import { EntityDirty, InterestManager } from '../src/world/interest-management.js';

describe('sector change log', () => {
  it('coalesces revisions for selected sectors and retains removal location', () => {
    const interest = new InterestManager();
    const locations = new Map([[7, { map: 1, x: 80, y: 96, sectorKey: 123 }]]);
    interest.bindLocationResolver((serial) => locations.get(serial));
    const firstCursor = interest.changeLog.sequence;
    interest.mark(7, EntityDirty.Position, 'mobile');
    interest.mark(7, EntityDirty.Vitals, 'mobile');
    locations.delete(7);
    interest.mark(7, EntityDirty.Removed, 'mobile');

    const result = interest.changesSince(firstCursor, { sectorKeys: [123] });
    expect(result.resetRequired).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      serial: 7,
      mask: EntityDirty.Position | EntityDirty.Vitals | EntityDirty.Removed,
      location: { map: 1, x: 80, y: 96, sectorKey: 123 },
    });
  });

  it('reports a required reset after a bounded sector ring overflows', () => {
    const interest = new InterestManager();
    interest.changeLog.sectorCapacity = 32;
    interest.bindLocationResolver(() => ({ map: 0, x: 8, y: 8, sectorKey: 1 }));
    for (let serial = 1; serial <= 40; serial++) interest.mark(serial, EntityDirty.Position, 'mobile');
    const result = interest.changesSince(1, { sectorKeys: [1] });
    expect(result.resetRequired).toBe(true);
    expect(result.changes.length).toBeLessThanOrEqual(32);
  });
});
