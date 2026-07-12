// Pure spatial grouping for roof/wall/ceiling visibility. Kept independent
// from Pixi and world state so it is cheap to test and reusable by chunk and
// dynamic-item renderers.

export function tallTileKey(x, y) { return ((y & 0xffff) << 16) | (x & 0xffff); }
export function boundsContains(bounds, x, y) {
  if (!bounds) return true;
  return x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
}
export function tallStaticBounds(x, y) { return { x0: x | 0, y0: y | 0, x1: x | 0, y1: y | 0 }; }
function mergeBounds(out, bounds) {
  if (!bounds) return out;
  if (bounds.x0 < out.x0) out.x0 = bounds.x0;
  if (bounds.y0 < out.y0) out.y0 = bounds.y0;
  if (bounds.x1 > out.x1) out.x1 = bounds.x1;
  if (bounds.y1 > out.y1) out.y1 = bounds.y1;
  return out;
}
function isStructurePart(entry) {
  return !!entry && !entry.isTransparent && (entry.isRoof || entry.isWall || entry.isCeilingSurface);
}
function touches(a, b) {
  const dx = Math.abs((a.x | 0) - (b.x | 0));
  const dy = Math.abs((a.y | 0) - (b.y | 0));
  if (dx > 1 || dy > 1) return false;
  const orthogonal = dx + dy <= 1;
  const diagonalRoof = dx === 1 && dy === 1 && a.isRoof && b.isRoof;
  if (!orthogonal && !diagonalRoof) return false;
  const dz = Math.abs((a.z | 0) - (b.z | 0));
  return dz <= ((a.isWall || b.isWall || a.isCeilingSurface || b.isCeilingSurface) ? 25 : 12);
}
export function createTallStructureScratch() {
  return { buckets: new Map(), bucketPool: [], usedBuckets: [], tallIndexes: [], stack: [], component: [], visited: new Set() };
}
function reset(work) {
  for (const bucket of work.usedBuckets) { bucket.length = 0; work.bucketPool.push(bucket); }
  work.usedBuckets.length = 0; work.buckets.clear(); work.tallIndexes.length = 0;
  work.stack.length = 0; work.component.length = 0; work.visited.clear();
}
function bucket(work, key) {
  let value = work.buckets.get(key);
  if (!value) { value = work.bucketPool.pop() ?? []; work.buckets.set(key, value); work.usedBuckets.push(value); }
  return value;
}
function seedWork(entries, work) {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isStructurePart(entry)) continue;
    work.tallIndexes.push(i);
    bucket(work, tallTileKey(entry.x | 0, entry.y | 0)).push(i);
  }
}
function collectComponent(entries, work, seed) {
  const { stack, component, visited } = work;
  stack.length = 0; component.length = 0; stack.push(seed); visited.add(seed);
  while (stack.length) {
    const index = stack.pop();
    const current = entries[index];
    component.push(current);
    const cx = current.x | 0, cy = current.y | 0;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const nearby = work.buckets.get(tallTileKey(x, y));
      if (!nearby) continue;
      for (const nextIndex of nearby) {
        if (visited.has(nextIndex) || !touches(current, entries[nextIndex])) continue;
        visited.add(nextIndex); stack.push(nextIndex);
      }
    }
  }
  return component;
}

export function assignTallStructureBounds(entries, scratch = null) {
  if (!Array.isArray(entries) || entries.length === 0) return entries;
  const work = scratch ?? createTallStructureScratch(); reset(work);
  try {
    for (const entry of entries) if (!entry.bounds) entry.bounds = tallStaticBounds(entry.x, entry.y);
    seedWork(entries, work);
    for (const seed of work.tallIndexes) {
      if (work.visited.has(seed)) continue;
      const component = collectComponent(entries, work, seed);
      let bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const entry of component) bounds = mergeBounds(bounds, entry.bounds);
      if (bounds.x0 !== Infinity) for (const entry of component) entry.bounds = bounds;
    }
    return entries;
  } finally { reset(work); }
}

export function tallStructureBoundsForPlayer(entries, playerX, playerY, playerZ, scratch = null) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const px = playerX | 0, py = playerY | 0, roofCut = (playerZ | 0) + 5;
  const work = scratch ?? createTallStructureScratch(); reset(work);
  try {
    seedWork(entries, work);
    for (const seed of work.tallIndexes) {
      if (work.visited.has(seed)) continue;
      const component = collectComponent(entries, work, seed);
      let bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      let hasCoverAbovePlayer = false;
      for (const entry of component) {
        bounds = mergeBounds(bounds, entry.bounds ?? tallStaticBounds(entry.x, entry.y));
        if (!entry.isTransparent
            && (entry.isRoof || entry.isCeilingSurface || (entry.isWall && (entry.height | 0) >= 20))
            && (entry.z | 0) >= roofCut) hasCoverAbovePlayer = true;
      }
      if (bounds.x0 !== Infinity && hasCoverAbovePlayer && boundsContains(bounds, px, py)) {
        for (const entry of component) entry.bounds = bounds;
        return bounds;
      }
    }
    return null;
  } finally { reset(work); }
}

export function shouldHideTallEntry(entry, playerX, playerY, indoors, roofCut, maxDrawZ, structureBounds = null) {
  if (!entry) return false;
  const inOwnBounds = boundsContains(entry.bounds, playerX, playerY);
  const inStructureBounds = !!structureBounds && boundsContains(structureBounds, entry.x | 0, entry.y | 0);
  if (entry.isRoof || entry.isCeilingSurface) {
    return !!indoors && (inOwnBounds || inStructureBounds) && (entry.z | 0) >= roofCut;
  }
  return inOwnBounds && (entry.z | 0) >= maxDrawZ;
}
