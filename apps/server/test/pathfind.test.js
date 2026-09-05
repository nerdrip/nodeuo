// A* pathfinding — uses the same `resolveStep` predicate as live movement,
// so we mock the land provider to lay out tiny test maps. Land at z=0
// everywhere by default; "walls" are made by NOT registering land there
// (resolveStep returns null for unmapped tiles).

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

const { findPath, findPathHierarchical, PathfindingGovernor } = await import('../src/world/pathfind.js');

function fillRect(x0, y0, x1, y1, z = 0) {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      land.set(`${x},${y}`, { z });
    }
  }
}

// Place a "wall" — drop the land tile and put a non-walkable, non-impassable
// static there. The static has unknown tileId (flags=0 by fallback in
// movement.js's staticInfo), which:
//   1. blocks resolveCardinalStep's permissive "no land + no statics → z"
//      shortcut (because statics.length > 0), and
//   2. fails the Surface filter so it never becomes a walkable candidate.
// Result: stepping onto this tile returns null = blocked.
function placeWall(x, y) {
  land.delete(`${x},${y}`);
  statics.set(`${x},${y}`, [{ tileId: 0xFFFE, z: 0 }]);
}

beforeEach(() => {
  land.clear();
  statics.clear();
});

describe('findPath', () => {
  it('returns empty array when start is already adjacent to goal', () => {
    fillRect(0, 0, 5, 5);
    const path = findPath({ facet: 1, sx: 2, sy: 2, sz: 0, gx: 3, gy: 2 });
    expect(path).toEqual([]);
  });

  it('finds a straight diagonal path on open ground', () => {
    fillRect(0, 0, 10, 10);
    const path = findPath({ facet: 1, sx: 0, sy: 0, sz: 0, gx: 5, gy: 5 });
    expect(path).toBeTruthy();
    // Adjacent-to-goal stops 1 short — so 4 diagonal steps from (0,0) to (4,4).
    expect(path.length).toBe(4);
    // Each step should be diagonal SE (dir 3).
    expect(path.every((d) => d === 3)).toBe(true);
  });

  it('routes around a wall instead of through it', () => {
    fillRect(0, 0, 10, 10);
    // Vertical wall at x=5, y=0..7 (gap at y=8,9 to detour around).
    // Beyond y=10 there's no land — but resolveStep's "no land + no
    // statics → permissive" fallback would let A* escape into open
    // void. Wall the column far enough that the planner can't go
    // around the outside of the playable rect.
    for (let y = -30; y <= 7; y++) placeWall(5, y);
    const path = findPath({ facet: 1, sx: 2, sy: 2, sz: 0, gx: 8, gy: 2 });
    expect(path).toBeTruthy();
    // Walk the path mentally: every visited tile (computed below) must
    // exist in `land`.
    let x = 2, y = 2;
    const DIRS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    for (const d of path) {
      const [dx, dy] = DIRS[d];
      x += dx; y += dy;
      expect(land.has(`${x},${y}`)).toBe(true);
    }
    // Within goalRadius=1 of (8,2).
    expect(Math.max(Math.abs(x - 8), Math.abs(y - 2))).toBeLessThanOrEqual(1);
  });

  it('returns null when the goal is unreachable (boxed in by wall)', () => {
    fillRect(0, 0, 10, 10);
    // Full vertical wall at x=5 — extend it far past the rect so A*
    // can't loop around through "permissive" empty space.
    for (let y = -30; y <= 30; y++) placeWall(5, y);
    const path = findPath({ facet: 1, sx: 2, sy: 2, sz: 0, gx: 8, gy: 5 });
    expect(path).toBeNull();
  });

  it('returns null when node budget is exceeded', () => {
    fillRect(0, 0, 50, 50);
    // Reachable, but tiny budget forces give-up.
    const path = findPath({
      facet: 1, sx: 0, sy: 0, sz: 0, gx: 40, gy: 40, maxNodes: 10,
    });
    expect(path).toBeNull();
  });

  it('respects custom goalRadius', () => {
    fillRect(0, 0, 10, 10);
    // goalRadius 3 means anywhere within 3 tiles Chebyshev counts as arrived.
    const path = findPath({
      facet: 1, sx: 0, sy: 0, sz: 0, gx: 5, gy: 5, goalRadius: 3,
    });
    expect(path).toBeTruthy();
    // Should be shorter than the radius-1 case (4 steps).
    expect(path.length).toBeLessThan(4);
  });

  it('stitches long routes from bounded validated macro segments', () => {
    fillRect(0, 0, 100, 10);
    const path = findPathHierarchical({
      facet: 1, sx: 1, sy: 5, sz: 0, gx: 80, gy: 5,
      goalRadius: 1, maxNodes: 1200, segmentSize: 12, segmentNodes: 150,
    });
    expect(path).toBeTruthy();
    expect(path.length).toBeGreaterThan(60);
    expect(path.every((direction) => direction === 2)).toBe(true);
  });

  it('caches paths by collision revision and enforces a per-pulse budget', () => {
    fillRect(0, 0, 20, 20);
    let revision = 1;
    const governor = new PathfindingGovernor({
      sectors: { collisionRevisionForRange: () => revision },
    }, { maxPathsPerPulse: 1, maxNodesPerPulse: 400, cacheTtlMs: 10_000 });
    governor.beginPulse();
    const opts = { facet: 1, sx: 1, sy: 1, sz: 0, gx: 8, gy: 8, maxNodes: 400 };
    expect(governor.find(opts)).toBeTruthy();
    expect(governor.find(opts)).toBeTruthy();
    expect(governor.find({ ...opts, sx: 2, sy: 2 })).toBeTruthy();
    expect(governor.find({ ...opts, gx: 9 })).toBeNull();
    expect(governor.snapshot()).toMatchObject({ cacheHits: 2, budgetRejected: 1, solved: 1 });
    expect(governor.snapshot().routeSuffixSeeds).toBeGreaterThan(0);
    revision++;
    governor.beginPulse();
    expect(governor.find(opts)).toBeTruthy();
    expect(governor.snapshot().cacheMisses).toBe(3);
  });

  it('shares a validated goal field between agents with different node budgets', () => {
    fillRect(0, 0, 30, 30);
    const governor = new PathfindingGovernor({
      sectors: { collisionRevisionForRange: () => 7 },
    }, { maxPathsPerPulse: 1, maxNodesPerPulse: 500, cacheTtlMs: 10_000 });
    governor.beginPulse();
    expect(governor.find({ facet: 1, sx: 1, sy: 1, sz: 0,
      gx: 12, gy: 12, maxNodes: 500 })).toBeTruthy();
    const shared = governor.find({ facet: 1, sx: 2, sy: 2, sz: 0,
      gx: 12, gy: 12, maxNodes: 127 });
    expect(shared).toBeTruthy();
    expect(governor.snapshot()).toMatchObject({ solved: 1, goalFieldHits: 1, goalFields: 1 });
  });
});
