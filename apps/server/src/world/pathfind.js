// A* pathfinding on the walkable-tile graph. Uses `resolveStep` (the
// same predicate the move-handler uses) so any path the planner finds
// is a path the player/AI can actually walk. 8-directional moves;
// straight cost = 10, diagonal cost = 14 (octile distance).
//
// Designed for short tactical routes (a monster going around a wall to
// reach a player), not cross-shard navigation. Caller passes a node
// budget — once exceeded we give up and return `null` so the AI can
// fall back to "step naively, accept being blocked".
//
// Upgrade 2026-05-15 — port of ServUO FastAStar:
//   • Binary min-heap open list (O(log N) extraction) instead of linear scan.
//   • Closed flag stored on node (no Infinity-marker overload of `f`).
//   • Recursive parent walk replaced with iterative chain so deeper paths
//     don't blow the stack on tight dungeon corridors.
//   • Default maxNodes kept at 400 for compat — large-area planners
//     (boss aggro across full dungeons) should pass `maxNodes: 4000+`
//     explicitly. CUO's `PathFinder.MaxNodes = 10000` is a safe ceiling.

import { resolveStep } from './movement.js';

const DIRS = [
  // dir, dx, dy, cost
  [0,  0, -1, 10],   // North
  [1,  1, -1, 14],   // NE
  [2,  1,  0, 10],   // East
  [3,  1,  1, 14],   // SE
  [4,  0,  1, 10],   // South
  [5, -1,  1, 14],   // SW
  [6, -1,  0, 10],   // West
  [7, -1, -1, 14],   // NW
];

/** Octile distance heuristic — admissible for diag=14, straight=10. */
function heuristic(x, y, gx, gy) {
  const dx = Math.abs(x - gx);
  const dy = Math.abs(y - gy);
  return 10 * (dx + dy) + (14 - 2 * 10) * Math.min(dx, dy);
}

/** Pack (x, y) into a single integer key for the open/closed sets. */
function key(x, y) { return ((x & 0xFFFF) << 16) | (y & 0xFFFF); }

// ---- Binary min-heap (priority queue by f-score) -----------------------

class MinHeap {
  constructor() { this.data = []; }
  get length() { return this.data.length; }
  push(node) {
    this.data.push(node);
    this._bubbleUp(this.data.length - 1);
  }
  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }
  _bubbleUp(i) {
    const d = this.data;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p].f <= d[i].f) break;
      [d[p], d[i]] = [d[i], d[p]];
      i = p;
    }
  }
  _bubbleDown(i) {
    const d = this.data;
    const n = d.length;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let best = i;
      if (l < n && d[l].f < d[best].f) best = l;
      if (r < n && d[r].f < d[best].f) best = r;
      if (best === i) break;
      [d[best], d[i]] = [d[i], d[best]];
      i = best;
    }
  }
}

/**
 * @param {Object} opts
 * @param {number} opts.facet
 * @param {number} opts.sx start x
 * @param {number} opts.sy start y
 * @param {number} opts.sz start z
 * @param {number} opts.gx goal x
 * @param {number} opts.gy goal y
 * @param {number} [opts.maxNodes=400] node budget — A* gives up past this
 * @param {number} [opts.goalRadius=1] consider any tile within this Chebyshev distance of (gx,gy) as the goal — useful for "get adjacent to the target" rather than landing on its tile
 * @returns {number[] | null}  array of direction codes (0..7) to walk, or null on failure
 */
export function findPath({ facet, sx, sy, sz, gx, gy, maxNodes = 400, goalRadius = 1 }) {
  if (Math.max(Math.abs(sx - gx), Math.abs(sy - gy)) <= goalRadius) return [];

  /** @type {Map<number, {x:number, y:number, z:number, g:number, f:number, parent:number, dir:number, closed:boolean}>} */
  const all = new Map();
  const open = new MinHeap();

  const startKey = key(sx, sy);
  const start = {
    x: sx, y: sy, z: sz, g: 0, f: heuristic(sx, sy, gx, gy),
    parent: -1, dir: -1, closed: false, _key: startKey,
  };
  all.set(startKey, start);
  open.push(start);

  let visited = 0;
  while (open.length) {
    if (++visited > maxNodes) return null;

    const cur = open.pop();
    if (cur.closed) continue;       // stale heap entry, skip
    cur.closed = true;

    if (Math.max(Math.abs(cur.x - gx), Math.abs(cur.y - gy)) <= goalRadius) {
      // Reconstruct iteratively.
      const out = [];
      let n = cur;
      while (n.parent !== -1) {
        out.push(n.dir);
        n = all.get(n.parent);
      }
      return out.reverse();
    }

    for (const [dir, dx, dy, cost] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nz = resolveStep(facet, cur.x, cur.y, cur.z, nx, ny);
      if (nz === null) continue;
      const nKey = key(nx, ny);
      const newG = cur.g + cost;
      const existing = all.get(nKey);
      if (existing && existing.g <= newG) continue;
      const node = {
        x: nx, y: ny, z: nz, g: newG,
        f: newG + heuristic(nx, ny, gx, gy),
        parent: cur._key, dir, closed: false, _key: nKey,
      };
      all.set(nKey, node);
      open.push(node);
    }
  }
  return null;
}
