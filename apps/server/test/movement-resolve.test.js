// Unit tests for `resolveStep`.
//
// We mock `landProvider` so each test can build a synthetic tile layout
// on the fly. The real movement code runs against the same interface it
// uses in production — so these tests lock in the rules independently of
// the shipped map data.

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** @type {Map<string, {z:number} | null>} */
const land = new Map();
/** @type {Map<string, Array<{tileId:number,z:number}>>} */
const statics = new Map();

vi.mock('../src/world/land-provider.js', () => ({
  landProvider: {
    landAt: (_facet, x, y) => land.get(`${x},${y}`) ?? null,
    staticsAt: (_facet, x, y) => statics.get(`${x},${y}`) ?? [],
  },
}));

// Wall tile: Impassable + custom height. We piggyback on tiledata.json by
// using a known id — 0x0001 is always present in tiledata. But because we
// bypass the file-backed tiledata loader here, we import movement AFTER
// the mocks are set. Since movement's tiledata fallback treats unknown
// ids as 0/0, we'll synthesize flags by reassigning the in-module
// staticInfo via dynamic import + monkey-patch. The cleaner path is to
// pick tileIds whose actual tiledata.json entry matches what we want.
//
// Simplest: we only assert on pure-land behaviour (no statics) where the
// rule depends only on land and diagonal-cardinal connectivity.

const { resolveStep } = await import('../src/world/movement.js');

beforeEach(() => {
  land.clear();
  statics.clear();
});

describe('resolveStep', () => {
  it('allows a flat cardinal step', () => {
    land.set('10,10', { z: 0 });
    land.set('11,10', { z: 0 });
    expect(resolveStep(1, 10, 10, 0, 11, 10)).toBe(0);
  });

  it('is permissive when destination chunk is not loaded (landAt=null)', () => {
    // Matches production behaviour — the server refuses to strand a player
    // just because a chunk hasn't streamed in yet. The client predicts the
    // same way, so we stay in sync.
    land.set('10,10', { z: 5 });
    expect(resolveStep(1, 10, 10, 5, 11, 10)).toBe(5);
  });

  it('diagonal step: both cardinals walkable → diagonal allowed', () => {
    land.set('10,10', { z: 0 });
    land.set('11,10', { z: 0 });
    land.set('10,11', { z: 0 });
    land.set('11,11', { z: 0 });
    expect(resolveStep(1, 10, 10, 0, 11, 11)).toBe(0);
  });

  it('sloped tile uses 4-corner average as standing-Z (ServUO GetAverageZ)', () => {
    // (11,10) is the destination. Its 4 corners are land(11,10), (12,10),
    // (11,11), (12,11). With NW=0, NE=10, SW=0, SE=10, the slope's
    // floor-averaged center is 5 — that's where the mover stands, NOT at
    // the stored z=0. This is the whole point of ServUO's GetAverageZ:
    // server collision matches the stretched render the player sees.
    land.set('10,10', { z: 0 });
    land.set('11,10', { z: 0 });   // dest NW (also source NE)
    land.set('12,10', { z: 10 });  // dest NE
    land.set('11,11', { z: 0 });   // dest SW (also source SE)
    land.set('12,11', { z: 10 });  // dest SE
    expect(resolveStep(1, 10, 10, 0, 11, 10)).toBe(5);
  });

  it('large drop allowed (ServUO has no real drop limit)', () => {
    land.set('10,10', { z: 0 });
    land.set('11,10', { z: -50 });
    expect(resolveStep(1, 10, 10, 0, 11, 10)).toBe(-50);
  });

  it('drop past MAX_DROP=127 rejected', () => {
    land.set('10,10', { z: 0 });
    land.set('11,10', { z: -128 });
    expect(resolveStep(1, 10, 10, 0, 11, 10)).toBeNull();
  });

  it('rejects stepping onto an impassable land tile (water, etc.)', () => {
    // tiledata.json land[168] is water with flags 0xC0 (Wet|Impassable).
    // Without the land-flag check the mover would happily walk onto it
    // because the height-only test sees a perfectly flat surface.
    land.set('10,10', { z: 0, tileId: 3 });   // grass: flags 0
    land.set('11,10', { z: 0, tileId: 168 }); // water
    expect(resolveStep(1, 10, 10, 0, 11, 10)).toBeNull();
  });

  it('diagonal blocked when one cardinal is impassable land (water)', () => {
    // No-corner-cutting rule: even if the diagonal target itself is fine,
    // slipping past an impassable cardinal (water, wall, etc.) is rejected.
    land.set('10,10', { z: 0, tileId: 3 });
    land.set('11,10', { z: 0, tileId: 168 }); // east cardinal: water → impassable
    land.set('10,11', { z: 0, tileId: 3 });   // south cardinal: OK
    land.set('11,11', { z: 0, tileId: 3 });   // diagonal target: fine
    expect(resolveStep(1, 10, 10, 0, 11, 11)).toBeNull();
  });
});
