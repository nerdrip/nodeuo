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

const DIR_X = [0, 1, 1, 1, 0, -1, -1, -1];
const DIR_Y = [-1, -1, 0, 1, 1, 1, 0, -1];
const DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14];

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
    const data = this.data;
    let index = data.push(node) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (data[parent].f <= node.f) break;
      data[index] = data[parent];
      index = parent;
    }
    data[index] = node;
  }
  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      const data = this.data;
      let index = 0;
      const half = data.length >> 1;
      while (index < half) {
        let child = index * 2 + 1;
        const right = child + 1;
        if (right < data.length && data[right].f < data[child].f) child = right;
        if (data[child].f >= last.f) break;
        data[index] = data[child];
        index = child;
      }
      data[index] = last;
    }
    return top;
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

    for (let dir = 0; dir < 8; dir++) {
      const nx = cur.x + DIR_X[dir];
      const ny = cur.y + DIR_Y[dir];
      const nz = resolveStep(facet, cur.x, cur.y, cur.z, nx, ny);
      if (nz === null) continue;
      const nKey = key(nx, ny);
      const newG = cur.g + DIR_COST[dir];
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

/** Two-level planner for routes larger than one tactical search window.
 * It advances through bounded macro segments and validates every produced
 * step with the same resolveStep predicate as ordinary A*. The total node
 * allowance is split between segments, so long paths cannot bypass budgets. */
function findPathSegmentedDirect({ segmentSize = 16, segmentNodes = 160, ...opts }) {
  const normalized = {
    ...opts,
    facet: opts.facet | 0, sx: opts.sx | 0, sy: opts.sy | 0, sz: opts.sz | 0,
    gx: opts.gx | 0, gy: opts.gy | 0,
    goalRadius: Math.max(0, Number(opts.goalRadius ?? 1) | 0),
    maxNodes: Math.max(1, Number(opts.maxNodes) || 400) | 0,
  };
  const stride = Math.max(4, segmentSize | 0);
  let remainingNodes = normalized.maxNodes;
  let x = normalized.sx; let y = normalized.sy; let z = normalized.sz;
  const output = [];
  const maxSegments = Math.max(2, Math.ceil(Math.max(Math.abs(x - normalized.gx), Math.abs(y - normalized.gy)) / stride) + 4);
  for (let segment = 0; segment < maxSegments; segment++) {
    const dx = normalized.gx - x; const dy = normalized.gy - y;
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    if (distance <= normalized.goalRadius) return output;
    if (remainingNodes <= 0) return null;
    const final = distance <= stride;
    const scale = final ? 1 : stride / distance;
    const targetX = final ? normalized.gx : Math.round(x + dx * scale);
    const targetY = final ? normalized.gy : Math.round(y + dy * scale);
    const allowance = Math.min(remainingNodes, Math.max(32, segmentNodes | 0));
    const path = findPath({
      facet: normalized.facet, sx: x, sy: y, sz: z,
      gx: targetX, gy: targetY, maxNodes: allowance,
      goalRadius: final ? normalized.goalRadius : 2,
    });
    remainingNodes -= allowance;
    if (!path?.length) {
      if (final && path) return output;
      // A macro waypoint may land inside an obstacle. Spend the remaining
      // budget on a direct tactical fallback before declaring the route lost.
      if (remainingNodes <= 0) return null;
      const fallback = findPath({ ...normalized, sx: x, sy: y, sz: z, maxNodes: remainingNodes });
      return fallback ? output.concat(fallback) : null;
    }
    for (const direction of path) {
      const nx = x + DIR_X[direction]; const ny = y + DIR_Y[direction];
      const nz = resolveStep(normalized.facet, x, y, z, nx, ny);
      if (nz === null) return null;
      x = nx; y = ny; z = nz; output.push(direction);
    }
    if (final && Math.max(Math.abs(x - normalized.gx), Math.abs(y - normalized.gy)) <= normalized.goalRadius) return output;
  }
  return null;
}

/** Lazily generated macro-region portal candidates. It stores only geometry
 * coordinates; every actual crossing is still proven by tactical A*, so a
 * stale candidate can at worst miss and fall back — it cannot create an
 * illegal movement step. Collision revisions invalidate affected entries. */
export class RegionalPortalGraph {
  constructor(world = null, { maxEntries = 8192 } = {}) {
    this.world = world;
    this.maxEntries = Math.max(64, maxEntries | 0);
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0, searches: 0, solved: 0 };
  }

  _revision(facet, rx, ry, nx, ny, size) {
    const sectors = this.world?.sectors;
    if (!sectors?.collisionRevisionForRange) return 0;
    const x = Math.floor(((rx + nx + 1) * size) / 2);
    const y = Math.floor(((ry + ny + 1) * size) / 2);
    return sectors.collisionRevisionForRange(facet, x, y, size + 2);
  }

  candidates(facet, rx, ry, nx, ny, size) {
    const revision = this._revision(facet, rx, ry, nx, ny, size);
    const keyValue = `${facet}:${rx}:${ry}:${nx}:${ny}:${size}`;
    const cached = this.cache.get(keyValue);
    if (cached?.revision === revision) {
      this.cache.delete(keyValue); this.cache.set(keyValue, cached);
      this.stats.hits++;
      return cached.points;
    }
    this.stats.misses++;
    const dx = nx - rx; const dy = ny - ry;
    const points = [];
    const offsets = [0.5, 0.25, 0.75, 0.125, 0.875]
      .map((part) => Math.min(size - 1, Math.max(0, Math.floor(part * size))));
    if (dx !== 0 && dy === 0) {
      const x = dx > 0 ? nx * size : (nx + 1) * size - 1;
      for (const offset of offsets) points.push({ x, y: ry * size + offset });
    } else if (dy !== 0 && dx === 0) {
      const y = dy > 0 ? ny * size : (ny + 1) * size - 1;
      for (const offset of offsets) points.push({ x: rx * size + offset, y });
    }
    this.cache.set(keyValue, { revision, points });
    while (this.cache.size > this.maxEntries) {
      this.cache.delete(this.cache.keys().next().value); this.stats.evictions++;
    }
    return points;
  }

  snapshot() { return { ...this.stats, entries: this.cache.size, maxEntries: this.maxEntries }; }
}

function replayPath(facet, start, directions) {
  let x = start.x; let y = start.y; let z = start.z;
  for (const direction of directions) {
    const nx = x + DIR_X[direction]; const ny = y + DIR_Y[direction];
    const nz = resolveStep(facet, x, y, z, nx, ny);
    if (nz === null) return null;
    x = nx; y = ny; z = nz;
  }
  return { x, y, z };
}

/** Macro A* over region portals, invoked only after the cheaper straight
 * segment planner fails. This handles walls/rivers spanning several tactical
 * windows while keeping each search phase independently bounded. */
function findPathThroughPortals({ portalGraph, segmentSize = 16, segmentNodes = 160, ...opts }) {
  const graph = portalGraph ?? new RegionalPortalGraph();
  graph.stats.searches++;
  const size = Math.max(4, segmentSize | 0);
  const maxNodes = Math.max(1, Number(opts.maxNodes) || 400) | 0;
  const perProbe = Math.max(24, Math.min(Math.max(32, segmentNodes | 0), Math.floor(maxNodes / 3)));
  let remaining = maxNodes;
  const startRx = Math.floor(opts.sx / size), startRy = Math.floor(opts.sy / size);
  const goalRx = Math.floor(opts.gx / size), goalRy = Math.floor(opts.gy / size);
  const open = new MinHeap();
  const best = new Map();
  const start = {
    x: opts.sx | 0, y: opts.sy | 0, z: opts.sz | 0,
    rx: startRx, ry: startRy, path: [], g: 0,
    f: (Math.abs(startRx - goalRx) + Math.abs(startRy - goalRy)) * size * 10,
  };
  open.push(start); best.set(`${startRx}:${startRy}`, 0);
  const maxRegions = Math.max(8, Math.ceil(maxNodes / perProbe) * 4);
  let regions = 0;
  while (open.length && remaining > 0 && regions++ < maxRegions) {
    const current = open.pop();
    if (current.g !== best.get(`${current.rx}:${current.ry}`)) continue;
    if (current.rx === goalRx && current.ry === goalRy) {
      const allowance = Math.min(remaining, Math.max(perProbe, segmentNodes | 0));
      const tail = findPath({ ...opts, sx: current.x, sy: current.y, sz: current.z, maxNodes: allowance });
      if (tail) { graph.stats.solved++; return current.path.concat(tail); }
      remaining -= allowance;
    }
    const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .sort((a, b) => {
        const ah = Math.abs(current.rx + a[0] - goalRx) + Math.abs(current.ry + a[1] - goalRy);
        const bh = Math.abs(current.rx + b[0] - goalRx) + Math.abs(current.ry + b[1] - goalRy);
        return ah - bh;
      });
    for (const [dx, dy] of neighbours) {
      const nx = current.rx + dx; const ny = current.ry + dy;
      let connector = null; let endpoint = null;
      for (const point of graph.candidates(opts.facet | 0, current.rx, current.ry, nx, ny, size)) {
        if (remaining <= 0) break;
        const allowance = Math.min(remaining, perProbe);
        const candidate = findPath({
          facet: opts.facet | 0, sx: current.x, sy: current.y, sz: current.z,
          gx: point.x, gy: point.y, goalRadius: 0, maxNodes: allowance,
        });
        remaining -= allowance;
        if (!candidate) continue;
        const reached = replayPath(opts.facet | 0, current, candidate);
        if (!reached) continue;
        connector = candidate; endpoint = reached; break;
      }
      if (!connector || !endpoint) continue;
      const g = current.g + connector.length * 10;
      const regionKey = `${nx}:${ny}`;
      if ((best.get(regionKey) ?? Infinity) <= g) continue;
      best.set(regionKey, g);
      open.push({
        ...endpoint, rx: nx, ry: ny, path: current.path.concat(connector), g,
        f: g + (Math.abs(nx - goalRx) + Math.abs(ny - goalRy)) * size * 10,
      });
    }
  }
  return null;
}

export function findPathHierarchical(options) {
  const direct = findPathSegmentedDirect(options);
  return direct ?? findPathThroughPortals(options);
}

/**
 * Synchronous, budgeted facade used by AI scripts. The public `findPath`
 * function remains unchanged for protocol/gameplay compatibility; this layer
 * prevents hundreds of mobs from starting an expensive A* in one pulse and
 * memoizes short-lived results until nearby collision geometry changes.
 */
export class PathfindingGovernor {
  constructor(world, {
    maxPathsPerPulse = 32,
    maxNodesPerPulse = 16_000,
    cacheSize = 4096,
    cacheTtlMs = 1500,
    hierarchicalThreshold = 24,
    segmentSize = 16,
    maxGoalFields = 256,
  } = {}) {
    this.world = world;
    this.maxPathsPerPulse = Math.max(1, maxPathsPerPulse | 0);
    this.maxNodesPerPulse = Math.max(100, maxNodesPerPulse | 0);
    this.cacheSize = Math.max(32, cacheSize | 0);
    this.cacheTtlMs = Math.max(100, cacheTtlMs | 0);
    this.hierarchicalThreshold = Math.max(8, hierarchicalThreshold | 0);
    this.segmentSize = Math.max(4, segmentSize | 0);
    this.maxGoalFields = Math.max(16, maxGoalFields | 0);
    this.portalGraph = new RegionalPortalGraph(world);
    this._cache = new Map();
    this._goalFields = new Map();
    this._pulsePaths = 0;
    this._pulseNodes = 0;
    this.stats = {
      pulses: 0, requests: 0, solved: 0, failed: 0,
      cacheHits: 0, cacheMisses: 0, budgetRejected: 0, evictions: 0,
      hierarchicalRequests: 0, routeSuffixSeeds: 0,
      goalFieldHits: 0, goalFieldMisses: 0, goalFieldSeeds: 0,
    };
  }

  beginPulse() {
    this._pulsePaths = 0;
    this._pulseNodes = 0;
    this.stats.pulses++;
  }

  _revisionFor(opts) {
    const sectors = this.world?.sectors;
    if (!sectors?.collisionRevisionForRange) return sectors?.revision ?? 0;
    const cx = ((opts.sx | 0) + (opts.gx | 0)) >> 1;
    const cy = ((opts.sy | 0) + (opts.gy | 0)) >> 1;
    const range = Math.max(Math.abs((opts.sx | 0) - (opts.gx | 0)), Math.abs((opts.sy | 0) - (opts.gy | 0))) + 2;
    return sectors.collisionRevisionForRange(opts.facet | 0, cx, cy, range);
  }

  _cacheKey(opts) {
    return `${opts.facet}:${opts.sx}:${opts.sy}:${opts.sz}:${opts.gx}:${opts.gy}:${opts.maxNodes}:${opts.goalRadius}`;
  }

  _goalKey(opts) {
    return `${opts.facet}:${opts.gx}:${opts.gy}:${opts.goalRadius}`;
  }

  _goalFieldPath(opts, revision, now) {
    const keyValue = this._goalKey(opts);
    const field = this._goalFields.get(keyValue);
    if (!field || field.revision !== revision || now - field.at > this.cacheTtlMs) {
      if (field) this._goalFields.delete(keyValue);
      this.stats.goalFieldMisses++;
      return null;
    }
    let x = opts.sx; let y = opts.sy; let z = opts.sz;
    const result = [];
    const visited = new Set();
    const limit = Math.min(256, opts.maxNodes);
    for (let index = 0; index < limit; index++) {
      if (Math.max(Math.abs(x - opts.gx), Math.abs(y - opts.gy)) <= opts.goalRadius) {
        this._goalFields.delete(keyValue); this._goalFields.set(keyValue, field);
        this.stats.goalFieldHits++;
        return result;
      }
      const tile = `${x}:${y}:${z}`;
      if (visited.has(tile)) break;
      visited.add(tile);
      const direction = field.steps.get(tile);
      if (direction == null) break;
      const nx = x + DIR_X[direction]; const ny = y + DIR_Y[direction];
      const nz = resolveStep(opts.facet, x, y, z, nx, ny);
      if (nz === null) break;
      result.push(direction); x = nx; y = ny; z = nz;
    }
    this.stats.goalFieldMisses++;
    return null;
  }

  _seedGoalField(opts, path, revision, now) {
    if (!path?.length) return;
    const keyValue = this._goalKey(opts);
    let field = this._goalFields.get(keyValue);
    if (!field || field.revision !== revision) field = { revision, at: now, steps: new Map() };
    let x = opts.sx; let y = opts.sy; let z = opts.sz;
    for (const direction of path.slice(0, 256)) {
      field.steps.set(`${x}:${y}:${z}`, direction & 7);
      const nx = x + DIR_X[direction & 7]; const ny = y + DIR_Y[direction & 7];
      const nz = resolveStep(opts.facet, x, y, z, nx, ny);
      if (nz === null) break;
      x = nx; y = ny; z = nz;
    }
    field.at = now;
    this._goalFields.delete(keyValue); this._goalFields.set(keyValue, field);
    this.stats.goalFieldSeeds++;
    while (this._goalFields.size > this.maxGoalFields) this._goalFields.delete(this._goalFields.keys().next().value);
  }

  _seedRouteSuffixes(opts, path, revision, now) {
    let x = opts.sx; let y = opts.sy; let z = opts.sz;
    const limit = Math.min(path.length, 64);
    for (let index = 0; index < limit; index++) {
      const direction = path[index] & 7;
      const nx = x + DIR_X[direction]; const ny = y + DIR_Y[direction];
      const nz = resolveStep(opts.facet, x, y, z, nx, ny);
      if (nz === null) break;
      x = nx; y = ny; z = nz;
      const suffix = path.slice(index + 1);
      const keyValue = this._cacheKey({ ...opts, sx: x, sy: y, sz: z });
      this._cache.set(keyValue, { revision, at: now, path: suffix });
      this.stats.routeSuffixSeeds++;
    }
  }

  find(opts) {
    this.stats.requests++;
    const normalized = {
      ...opts,
      facet: opts.facet | 0, sx: opts.sx | 0, sy: opts.sy | 0, sz: opts.sz | 0,
      gx: opts.gx | 0, gy: opts.gy | 0,
      maxNodes: Math.max(1, Number(opts.maxNodes) || 400) | 0,
      goalRadius: Math.max(0, Number(opts.goalRadius ?? 1) | 0),
    };
    const revision = this._revisionFor(normalized);
    const cacheKey = this._cacheKey(normalized);
    const now = performance.now();
    const cached = this._cache.get(cacheKey);
    if (cached && cached.revision === revision && now - cached.at <= this.cacheTtlMs) {
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, cached);
      this.stats.cacheHits++;
      return cached.path ? cached.path.slice() : null;
    }
    if (cached) this._cache.delete(cacheKey);
    this.stats.cacheMisses++;
    const sharedPath = this._goalFieldPath(normalized, revision, now);
    if (sharedPath) return sharedPath;
    if (this._pulsePaths >= this.maxPathsPerPulse
        || this._pulseNodes + normalized.maxNodes > this.maxNodesPerPulse) {
      this.stats.budgetRejected++;
      return null;
    }
    this._pulsePaths++;
    this._pulseNodes += normalized.maxNodes;
    const distance = Math.max(Math.abs(normalized.sx - normalized.gx), Math.abs(normalized.sy - normalized.gy));
    const hierarchical = distance > this.hierarchicalThreshold;
    if (hierarchical) this.stats.hierarchicalRequests++;
    const path = hierarchical
      ? findPathHierarchical({ ...normalized, segmentSize: this.segmentSize, portalGraph: this.portalGraph })
      : findPath(normalized);
    if (path) this.stats.solved++;
    else this.stats.failed++;
    this._cache.set(cacheKey, { revision, at: now, path: path ? path.slice() : null });
    if (path?.length) this._seedRouteSuffixes(normalized, path, revision, now);
    if (path?.length) this._seedGoalField(normalized, path, revision, now);
    while (this._cache.size > this.cacheSize) {
      this._cache.delete(this._cache.keys().next().value);
      this.stats.evictions++;
    }
    return path;
  }

  clear() { this._cache.clear(); this._goalFields.clear(); }

  snapshot() {
    return {
      ...this.stats,
      cacheEntries: this._cache.size,
      goalFields: this._goalFields.size,
      pulsePaths: this._pulsePaths,
      pulseNodeBudget: this._pulseNodes,
      limits: {
        pathsPerPulse: this.maxPathsPerPulse,
        nodesPerPulse: this.maxNodesPerPulse,
        cacheSize: this.cacheSize,
        cacheTtlMs: this.cacheTtlMs,
        hierarchicalThreshold: this.hierarchicalThreshold,
        segmentSize: this.segmentSize,
        maxGoalFields: this.maxGoalFields,
      },
      portals: this.portalGraph.snapshot(),
    };
  }
}
