// Client-side A* pathfinder. Mirrors ClassicUO `Game/Pathfinder.cs`.
//
// Why client-side: ServUO accepts 0x38 PathfindingRequest but our shard's
// 0x38 handler is a stub (server emits no 0x97 ForceWalk stream). Without
// a local A*, RMB-double-click on the world does nothing. CUO falls back
// to client A* for the same reason.
//
// Algorithm: classic 8-direction A* with Manhattan-ish heuristic on
// `assets.landAt` + `assets.staticsAt`. Standing-Z is resolved at each
// step via `resolveLocalStandingZ` so stairs / bridges work. Diagonal
// steps require both orthogonal neighbours to be passable (corners can't
// be cut through walls).
//
// Exposes a single `pathfind(player, tx, ty, tz)` returning a list of
// directions (0..7 UO compass) the caller can feed into walker.reserve()
// or PlayerMobile.walk().

import { isLocallyBlocked, resolveLocalStandingZ } from './walkability.js';
import { profile } from '../managers/profile-manager.js';

// Audit #42 client P2 #13 — CUO `Pathfinder.cs:17` uses 10000. Was
// 4000; large dungeon mazes (Khaldun, Doom) reliably failed where CUO
// succeeded.
const MAX_NODES = 10000;
const MAX_STEPS = 200;            // path length cap
const MAX_DIST  = 60;             // tile distance cap (~3 screens)
const TILE_STRIDE = 8192;
const Z_STRIDE = TILE_STRIDE * TILE_STRIDE;
const WORKER_GRID_PAD_MIN = 8;
const WORKER_GRID_PAD_MAX = 20;
const WORKER_GRID_MAX_CELLS = 18_000;
const WORKER_TIMEOUT_MS = 650;

// dx, dy, cost (diagonals cost √2 ≈ 14, orthogonal 10 — integer math
// for simpler g-score updates). Split arrays avoid destructuring in the
// A* inner loop.
const DIR_X = [ 0, 1, 1, 1, 0, -1, -1, -1];
const DIR_Y = [-1,-1, 0, 1, 1,  1,  0, -1];
const DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14];

function key(x, y) { return ((y & 0xffff) << 16) | (x & 0xffff); }

function zKey(x, y, z) {
  return (((z + 128) & 0x3ff) * Z_STRIDE)
    + ((y & 0x1fff) * TILE_STRIDE)
    + (x & 0x1fff);
}

export const pathfindStats = {
  requests: 0,
  lastMs: 0,
  lastVisited: 0,
  lastOpenMax: 0,
  lastCacheHits: 0,
  lastCacheMisses: 0,
  lastBlockCacheHits: 0,
  lastBlockCacheMisses: 0,
  lastPathLength: 0,
  lastResult: 'idle',
};

function heapLess(a, b) {
  return a.f < b.f || (a.f === b.f && a.g > b.g);
}

function heapPush(heap, node) {
  let i = heap.length;
  heap.push(node);
  while (i > 0) {
    const p = (i - 1) >> 1;
    const parent = heap[p];
    if (!heapLess(node, parent)) break;
    heap[i] = parent;
    i = p;
  }
  heap[i] = node;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0 && last) {
    let i = 0;
    const half = heap.length >> 1;
    while (i < half) {
      let c = (i << 1) + 1;
      let child = heap[c];
      const r = c + 1;
      if (r < heap.length && heapLess(heap[r], child)) {
        c = r;
        child = heap[r];
      }
      if (!heapLess(child, last)) break;
      heap[i] = child;
      i = c;
    }
    heap[i] = last;
  }
  return top;
}

function resolveStandingZCached(cache, x, y, fromZ, map, stats) {
  const k = zKey(x, y, fromZ);
  const cached = cache.get(k);
  if (cached !== undefined) {
    stats.hits++;
    return cached;
  }
  const z = resolveLocalStandingZ(x, y, fromZ, map);
  cache.set(k, z);
  stats.misses++;
  return z;
}

function isBlockedCached(cache, x, y, fromZ, map, stats) {
  const k = zKey(x, y, fromZ);
  const cached = cache.get(k);
  if (cached !== undefined) {
    stats.blockHits++;
    return cached;
  }
  const blocked = isLocallyBlocked(x, y, fromZ, map);
  cache.set(k, blocked);
  stats.blockMisses++;
  return blocked;
}

function recordStats(startedAt, result, visited, openMax, cacheStats, pathLength) {
  pathfindStats.lastMs = performance.now() - startedAt;
  pathfindStats.lastResult = result;
  pathfindStats.lastVisited = visited | 0;
  pathfindStats.lastOpenMax = openMax | 0;
  pathfindStats.lastCacheHits = cacheStats?.hits | 0;
  pathfindStats.lastCacheMisses = cacheStats?.misses | 0;
  pathfindStats.lastBlockCacheHits = cacheStats?.blockHits | 0;
  pathfindStats.lastBlockCacheMisses = cacheStats?.blockMisses | 0;
  pathfindStats.lastPathLength = pathLength | 0;
}

/** Test whether the player can step from (sx,sy,sz) to (dx,dy) given our
 *  cached land/statics. Returns the destination z, or null if blocked. */
function canStep(sx, sy, sz, dx, dy, isDiag, map, zCache, blockCache, cacheStats) {
  if (isBlockedCached(blockCache, dx, dy, sz, map, cacheStats)) return null;
  const dz = resolveStandingZCached(zCache, dx, dy, sz, map, cacheStats);
  if (Math.abs(dz - sz) > 8) return null;
  // Diagonal — verify both orthogonal corner tiles are walkable too,
  // so you can't slip through a wall corner. Client audit #7 #1: was
  // `&&` (only reject if BOTH corners blocked) — allowed corner-cut
  // through a 1-tile-wide opening. Use `||` — ServUO no-corner-cutting.
  if (isDiag) {
    if (isBlockedCached(blockCache, dx, sy, sz, map, cacheStats)) return null;
    if (isBlockedCached(blockCache, sx, dy, sz, map, cacheStats)) return null;
    const z1 = resolveStandingZCached(zCache, dx, sy, sz, map, cacheStats);
    const z2 = resolveStandingZCached(zCache, sx, dy, sz, map, cacheStats);
    if (Math.abs(z1 - sz) > 8 || Math.abs(z2 - sz) > 8) return null;
  }
  return dz;
}

// Last-result memo. Repeating RMB-DC on the same destination tile is
// common (player walks → arrives → clicks again to refine). Caching
// the most recent solve avoids re-running A* for ~150ms while the
// world moves around. Invalidated by either: target change, source
// shifted by >1 tile, or 2s wall-clock TTL (handles map edits +
// chunk overlay refresh).
let _memo = null;          // { sx, sy, tx, ty, dirs, at }
let _worker = null;
let _workerSeq = 0;
const _workerPending = new Map();

const _scratch = {
  open: new Map(),
  heap: [],
  closed: new Set(),
  zCache: new Map(),
  blockCache: new Map(),
  cacheStats: { hits: 0, misses: 0, blockHits: 0, blockMisses: 0 },
  nodePool: [],
  usedNodes: [],
};

function acquireNode(x, y, z, g, f, k, parent, dir) {
  const node = _scratch.nodePool.pop() ?? {};
  node.x = x;
  node.y = y;
  node.z = z;
  node.g = g;
  node.f = f;
  node.k = k;
  node.parent = parent;
  node.dir = dir;
  _scratch.usedNodes.push(node);
  return node;
}

function resetScratch() {
  const { nodePool, usedNodes } = _scratch;
  for (let i = 0; i < usedNodes.length; i++) {
    const node = usedNodes[i];
    node.parent = null;
    if (nodePool.length < MAX_NODES) nodePool.push(node);
  }
  usedNodes.length = 0;
  _scratch.open.clear();
  _scratch.heap.length = 0;
  _scratch.closed.clear();
  _scratch.zCache.clear();
  _scratch.blockCache.clear();
  _scratch.cacheStats.hits = 0;
  _scratch.cacheStats.misses = 0;
  _scratch.cacheStats.blockHits = 0;
  _scratch.cacheStats.blockMisses = 0;
}

function _canUseWorkerPathfinding() {
  return profile.get('experimental.workerPathfinding') === true
    && typeof Worker !== 'undefined';
}

function _getWorker() {
  if (!_canUseWorkerPathfinding()) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./pathfinder-worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (event) => {
      const { id, ...result } = event.data || {};
      const pending = _workerPending.get(id);
      if (!pending) return;
      _workerPending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(result);
    };
    _worker.onerror = (event) => {
      const error = new Error(event?.message || 'pathfinder worker failed');
      for (const [id, pending] of _workerPending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        _workerPending.delete(id);
      }
      try { _worker.terminate(); } catch { /* ignore */ }
      _worker = null;
    };
    return _worker;
  } catch {
    _worker = null;
    return null;
  }
}

function _buildWorkerSnapshot(player, tx, ty) {
  const sx = player.x | 0;
  const sy = player.y | 0;
  const sz = player.z | 0;
  const map = (player.map ?? player.mapId ?? 1) | 0;
  const dx = Math.abs(sx - tx);
  const dy = Math.abs(sy - ty);
  const pad = Math.max(WORKER_GRID_PAD_MIN, Math.min(WORKER_GRID_PAD_MAX, Math.ceil(Math.max(dx, dy) / 3)));
  const minX = Math.min(sx, tx) - pad;
  const minY = Math.min(sy, ty) - pad;
  const maxX = Math.max(sx, tx) + pad;
  const maxY = Math.max(sy, ty) + pad;
  const width = (maxX - minX + 1) | 0;
  const height = (maxY - minY + 1) | 0;
  const cells = width * height;
  if (cells <= 0 || cells > WORKER_GRID_MAX_CELLS) return null;

  const zData = new Int16Array(cells);
  const blocked = new Uint8Array(cells);
  for (let y = 0; y < height; y++) {
    const wy = minY + y;
    for (let x = 0; x < width; x++) {
      const wx = minX + x;
      const idx = y * width + x;
      zData[idx] = resolveLocalStandingZ(wx, wy, sz, map);
      blocked[idx] = isLocallyBlocked(wx, wy, sz, map) ? 1 : 0;
    }
  }

  return {
    sx, sy, sz, tx: tx | 0, ty: ty | 0,
    minX, minY, width, height,
    maxNodes: MAX_NODES,
    maxSteps: MAX_STEPS,
    zBuffer: zData.buffer,
    blockedBuffer: blocked.buffer,
  };
}

function _postWorkerPathfind(request) {
  const worker = _getWorker();
  if (!worker) return Promise.reject(new Error('pathfinder worker unavailable'));
  const id = (++_workerSeq) >>> 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _workerPending.delete(id);
      reject(new Error('pathfinder worker timeout'));
    }, WORKER_TIMEOUT_MS);
    _workerPending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, request }, [request.zBuffer, request.blockedBuffer]);
  });
}

async function _pathfindViaWorker(player, tx, ty) {
  pathfindStats.requests++;
  const startedAt = performance.now();
  const sx = player.x | 0;
  const sy = player.y | 0;
  const map = (player.map ?? player.mapId ?? 1) | 0;
  if (sx === tx && sy === ty) {
    recordStats(startedAt, 'same-tile', 0, 0, null, 0);
    return [];
  }
  if (Math.abs(sx - tx) > MAX_DIST || Math.abs(sy - ty) > MAX_DIST) {
    recordStats(startedAt, 'too-far', 0, 0, null, 0);
    return null;
  }
  const snapshot = _buildWorkerSnapshot(player, tx, ty);
  if (!snapshot) throw new Error('pathfinder snapshot too large');
  const result = await _postWorkerPathfind(snapshot);
  const dirs = Array.isArray(result?.dirs) ? result.dirs : null;
  const resultName = result?.result || 'worker-empty';
  recordStats(
    startedAt,
    resultName === 'found' ? 'worker-found' : resultName,
    result?.visited | 0,
    result?.openMax | 0,
    null,
    dirs?.length ?? (result?.pathLength | 0),
  );
  if (dirs?.length) {
    _memo = { sx, sy, tx, ty, map, dirs: [...dirs], at: performance.now() };
    return dirs;
  }
  return dirs;
}

/** A* search.
 * @param {{x:number,y:number,z:number}} player
 * @param {number} tx
 * @param {number} ty
 * @returns {number[] | null} array of UO directions, or null on failure */
export function pathfind(player, tx, ty) {
  pathfindStats.requests++;
  const startedAt = performance.now();
  const sx = player.x | 0, sy = player.y | 0, sz = player.z | 0;
  const map = (player.map ?? player.mapId ?? 1) | 0;
  if (sx === tx && sy === ty) {
    recordStats(startedAt, 'same-tile', 0, 0, null, 0);
    return [];
  }
  if (Math.abs(sx - tx) > MAX_DIST || Math.abs(sy - ty) > MAX_DIST) {
    recordStats(startedAt, 'too-far', 0, 0, null, 0);
    return null;
  }
  // Memo hit — same destination, source close enough, fresh.
  if (_memo
      && _memo.map === map
      && _memo.tx === tx && _memo.ty === ty
      && Math.abs(_memo.sx - sx) <= 1 && Math.abs(_memo.sy - sy) <= 1
      && performance.now() - _memo.at < 2000) {
    // Trim leading dirs the player has already walked.
    const dx = sx - _memo.sx, dy = sy - _memo.sy;
    if (dx === 0 && dy === 0) {
      recordStats(startedAt, 'memo', 0, 0, null, _memo.dirs.length);
      return _memo.dirs;
    }
    // Source moved 1 tile — drop the first matching direction if it
    // matches the player's actual step. Keeps memo viable while
    // walking the path tile-by-tile.
    const firstDir = _memo.dirs[0];
    if (firstDir != null) {
      const exDx = DIR_X[firstDir];
      const exDy = DIR_Y[firstDir];
      if (exDx === dx && exDy === dy) {
        _memo.dirs.shift();
        _memo.sx = sx;
        _memo.sy = sy;
        _memo.at = performance.now();
        if (_memo.dirs.length > 0) {
          recordStats(startedAt, 'memo-trimmed', 0, 0, null, _memo.dirs.length);
          return _memo.dirs;
        }
      }
    }
  }

  resetScratch();
  const { open, heap, closed, zCache, blockCache, cacheStats } = _scratch;
  try {
    const startKey = key(sx, sy);
    const start = acquireNode(sx, sy, sz, 0, 0, startKey, null, -1);
    open.set(startKey, start);
    heapPush(heap, start);
    let openMax = heap.length;

    let visited = 0;
    while (heap.length > 0 && visited < MAX_NODES) {
      let best = null;
      let bestK = -1;
      while (heap.length > 0) {
        const candidate = heapPop(heap);
        if (!candidate) break;
        const ck = candidate.k | 0;
        if (closed.has(ck)) continue;
        if (open.get(ck) !== candidate) continue;
        best = candidate;
        bestK = ck;
        break;
      }
      if (!best) break;
      visited++;
      open.delete(bestK);
      closed.add(bestK);

      if (best.x === tx && best.y === ty) {
        // Reconstruct path of directions.
        const out = [];
        for (let n = best; n.parent; n = n.parent) out.push(n.dir);
        out.reverse();
        if (out.length > MAX_STEPS) {
          recordStats(startedAt, 'too-long', visited, openMax, cacheStats, out.length);
          return null;
        }
        _memo = { sx, sy, tx, ty, map, dirs: out, at: performance.now() };
        recordStats(startedAt, 'found', visited, openMax, cacheStats, out.length);
        return out;
      }

      for (let d = 0; d < 8; d++) {
        const ddx = DIR_X[d];
        const ddy = DIR_Y[d];
        const cost = DIR_COST[d];
        const nx = best.x + ddx, ny = best.y + ddy;
        const k = key(nx, ny);
        if (closed.has(k)) continue;
        const isDiag = (d & 1) === 1;
        const nz = canStep(best.x, best.y, best.z, nx, ny, isDiag, map, zCache, blockCache, cacheStats);
        if (nz === null) continue;
        const g = best.g + cost;
        const h = (Math.abs(nx - tx) + Math.abs(ny - ty)) * 10;
        const f = g + h;
        const existing = open.get(k);
        if (existing && existing.g <= g) continue;
        const node = acquireNode(nx, ny, nz, g, f, k, best, d);
        open.set(k, node);
        heapPush(heap, node);
        if (heap.length > openMax) openMax = heap.length;
      }
    }
    recordStats(startedAt, 'failed', visited, openMax, cacheStats, 0);
    return null;
  } finally {
    resetScratch();
  }
}

/** Async pathfinder entry point. Uses the opt-in worker pipeline when
 *  `experimental.workerPathfinding` is enabled and falls back to the
 *  canonical synchronous solver for exact compatibility. */
export function pathfindAsync(player, tx, ty) {
  if (!_canUseWorkerPathfinding()) return Promise.resolve(pathfind(player, tx, ty));
  return _pathfindViaWorker(player, tx, ty).catch(() => pathfind(player, tx, ty));
}
