// Optional worker-side A* solver for client autowalk.
//
// The main thread still owns UO walkability truth. It sends a compact
// tile snapshot (blocked + standing Z) around the request, while this
// worker does the expensive open/closed-set search without blocking
// rendering/input.

const DIR_X = [0, 1, 1, 1, 0, -1, -1, -1];
const DIR_Y = [-1, -1, 0, 1, 1, 1, 0, -1];
const DIR_COST = [10, 14, 10, 14, 10, 14, 10, 14];

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

function solve(req) {
  const width = req.width | 0;
  const height = req.height | 0;
  const minX = req.minX | 0;
  const minY = req.minY | 0;
  const sx = req.sx | 0;
  const sy = req.sy | 0;
  const sz = req.sz | 0;
  const tx = req.tx | 0;
  const ty = req.ty | 0;
  const maxNodes = req.maxNodes | 0;
  const maxSteps = req.maxSteps | 0;
  const zData = new Int16Array(req.zBuffer);
  const blocked = new Uint8Array(req.blockedBuffer);

  const toLocalX = (x) => (x | 0) - minX;
  const toLocalY = (y) => (y | 0) - minY;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < width && y < height;
  const idx = (x, y) => y * width + x;

  const startX = toLocalX(sx);
  const startY = toLocalY(sy);
  const targetX = toLocalX(tx);
  const targetY = toLocalY(ty);
  if (!inBounds(startX, startY) || !inBounds(targetX, targetY)) {
    return { result: 'worker-out-of-bounds', dirs: null, visited: 0, openMax: 0 };
  }

  const canStep = (node, nx, ny, isDiag) => {
    if (!inBounds(nx, ny)) return null;
    const nIdx = idx(nx, ny);
    if (blocked[nIdx]) return null;
    const nz = zData[nIdx] | 0;
    if (Math.abs(nz - node.z) > 8) return null;
    if (isDiag) {
      const ax = idx(nx, node.ly);
      const ay = idx(node.lx, ny);
      if (blocked[ax] || blocked[ay]) return null;
      const z1 = zData[ax] | 0;
      const z2 = zData[ay] | 0;
      if (Math.abs(z1 - node.z) > 8 || Math.abs(z2 - node.z) > 8) return null;
    }
    return nz;
  };

  const open = new Map();
  const closed = new Uint8Array(width * height);
  const heap = [];
  const startKey = idx(startX, startY);
  const start = { lx: startX, ly: startY, z: sz, g: 0, f: 0, key: startKey, parent: null, dir: -1 };
  open.set(startKey, start);
  heapPush(heap, start);

  let openMax = heap.length;
  let visited = 0;

  while (heap.length > 0 && visited < maxNodes) {
    let best = null;
    while (heap.length > 0) {
      const candidate = heapPop(heap);
      if (!candidate) break;
      if (closed[candidate.key]) continue;
      if (open.get(candidate.key) !== candidate) continue;
      best = candidate;
      break;
    }
    if (!best) break;

    visited++;
    open.delete(best.key);
    closed[best.key] = 1;

    if (best.lx === targetX && best.ly === targetY) {
      const dirs = [];
      for (let n = best; n.parent; n = n.parent) dirs.push(n.dir);
      dirs.reverse();
      if (dirs.length > maxSteps) {
        return { result: 'too-long', dirs: null, visited, openMax, pathLength: dirs.length };
      }
      return { result: 'found', dirs, visited, openMax, pathLength: dirs.length };
    }

    for (let dir = 0; dir < 8; dir++) {
      const nx = best.lx + DIR_X[dir];
      const ny = best.ly + DIR_Y[dir];
      if (!inBounds(nx, ny)) continue;
      const nKey = idx(nx, ny);
      if (closed[nKey]) continue;
      const nz = canStep(best, nx, ny, (dir & 1) === 1);
      if (nz === null) continue;
      const wx = minX + nx;
      const wy = minY + ny;
      const g = best.g + DIR_COST[dir];
      const h = (Math.abs(wx - tx) + Math.abs(wy - ty)) * 10;
      const existing = open.get(nKey);
      if (existing && existing.g <= g) continue;
      const node = { lx: nx, ly: ny, z: nz, g, f: g + h, key: nKey, parent: best, dir };
      open.set(nKey, node);
      heapPush(heap, node);
      if (heap.length > openMax) openMax = heap.length;
    }
  }

  return { result: 'failed', dirs: null, visited, openMax, pathLength: 0 };
}

self.onmessage = (event) => {
  const { id, request } = event.data || {};
  try {
    self.postMessage({ id, ...solve(request) });
  } catch (error) {
    self.postMessage({ id, result: 'worker-error', error: String(error?.message || error), dirs: null });
  }
};
