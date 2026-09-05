// Visibility helpers — who sees whom and who sees what.
//
// The UO client has an "update range" of about 18 tiles (configurable via
// 0xC8 SetUpdateRange). For MVP we use a fixed radius and Chebyshev distance.
//
// History note: these used to walk `world.mobiles` / `world.items` linearly
// because at MVP scale (a few hundred entries) it was simpler and matched
// test fixtures. With a populated shard (110k items, 200+ NPCs) the linear
// `nearbyItems` walk dominated `refreshSurroundings` cost and was a
// primary teleport-freeze contributor — every TP did 110k iterations to
// pick the ≤200 visible items. We now route through `world.sectors`
// (8×8 tile buckets, see `world/sectors.js`) when present and fall back
// to the linear walk when not (test setups that bypass createItem don't
// populate the index).

import { runtimeGovernor } from '../systems/runtime-governor.js';
import { legacyNearbyClients, legacyNearbyItems, legacyNearbyMobiles } from './visibility-compat.js';

export const UPDATE_RANGE = 18;
const WORLD_CACHE_IDS = new WeakMap();
let NEXT_WORLD_CACHE_ID = 1;

function _worldCacheId(world) {
  let id = WORLD_CACHE_IDS.get(world);
  if (!id) {
    id = NEXT_WORLD_CACHE_ID++;
    WORLD_CACHE_IDS.set(world, id);
  }
  return id;
}

/** @param {{x:number,y:number,map:number}} a @param {{x:number,y:number,map:number}} b */
export function inRange(a, b, range = UPDATE_RANGE) {
  if (a.map !== b.map) return false;
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return Math.max(dx, dy) <= range;
}

/** Server-side phase filtering also protects classic clients: they simply
 * never receive entities from another layer and require no new packet. */
export function inWorldLayer(observer, entity) {
  const observerLayer = String(observer?.nodeUOWorldLayer || 'base');
  const entityLayer = String(entity?.nodeUOWorldLayer || 'base');
  return observerLayer === '*' || entityLayer === '*' || observerLayer === entityLayer;
}

/** True when the sectors index has at least one entry per known mobile.
 *  Tests stuff values straight into world.mobiles via `.set()` (bypassing
 *  createMobile, which is what populates sectors), and a stale or empty
 *  index would silently drop visibility results. The check is O(1). */
function _mobilesSectorsUsable(world) {
  return !!world.sectors
      && (world._sectorIndexAuthoritative
        || world.sectors.mobilesIndexed() >= world.mobiles.size);
}
function _itemsSectorsUsable(world) {
  // The sectors index only buckets parent-less ground items, so its
  // count can lag world.items (which also stores worn / contained
  // items). A strict equality check would miss the index whenever any
  // worn item exists. Heuristic: if at least one item is indexed, the
  // index is being maintained by createItem/destroyItem and we can
  // trust it. Empty index + non-empty world.items = test fixture →
  // fall back.
  if (!world.sectors) return false;
  if (world._sectorIndexAuthoritative) return true;
  if (world.items.size === 0) return true;
  const indexed = world.sectors.itemsIndexed();
  if (indexed === 0) return false;
  // Production maintains this cardinality incrementally. Compatibility
  // fixtures that bypass createItem keep the zero value and use the fallback.
  const ground = world._groundItemCount | 0;
  if (ground <= 0) return true;
  return indexed >= Math.floor(ground * 0.9);
}

function _sectorCandidates(world, kind, center, range) {
  // All centers inside one 8x8 sector share a conservative candidate set.
  // Exact `inRange` filtering still happens below, but hundreds of AI mobs
  // in the same sector no longer allocate identical serial arrays separately.
  const anchorX = ((center.x | 0) >> 3) * 8 + 3;
  const anchorY = ((center.y | 0) >> 3) * 8 + 3;
  const candidateRange = (range | 0) + 8;
  const revision = world.sectors.revisionForRange?.(center.map | 0, anchorX, anchorY, candidateRange)
    ?? world.sectors.revision ?? 0;
  // The governor cache is process-wide, therefore the world identity must be
  // part of the key (tests and staged world reloads may share revisions).
  const key = `${_worldCacheId(world)}:${kind}:${center.map | 0}:${anchorX >> 3}:${anchorY >> 3}:${range | 0}`;
  let serials = runtimeGovernor.visibilityCache.get(key, revision);
  if (serials) return serials;
  serials = [...(kind === 'mobile'
    ? world.sectors.mobileSerialsNear(center.map | 0, anchorX, anchorY, candidateRange)
    : world.sectors.itemSerialsNear(center.map | 0, anchorX, anchorY, candidateRange))];
  return runtimeGovernor.visibilityCache.set(key, revision, serials);
}

/**
 * Iterate all connected mobiles (other than `self`) within range of `center`.
 * Sector-indexed when the index is fully populated; falls back to a full
 * walk for test fixtures that bypass createMobile.
 */
export function* nearbyClients(world, center, self = null, range = UPDATE_RANGE) {
  if (_mobilesSectorsUsable(world)) {
    for (const serial of _sectorCandidates(world, 'mobile', center, range)) {
      const m = world.mobiles.get(serial);
      if (!m || m === self || !m.client || !inWorldLayer(center, m)) continue;
      if (inRange(center, m, range)) yield m;
    }
    return;
  }
  for (const mobile of legacyNearbyClients(world, center, self, range, inRange)) {
    if (inWorldLayer(center, mobile)) yield mobile;
  }
}

/**
 * Iterate every mobile (NPCs and players) within range of `center`, except
 * `self`. Sector-indexed when the index is fully populated.
 */
export function* nearbyMobiles(world, center, self = null, range = UPDATE_RANGE) {
  if (_mobilesSectorsUsable(world)) {
    for (const serial of _sectorCandidates(world, 'mobile', center, range)) {
      const m = world.mobiles.get(serial);
      // A ridden creature remains in world.mobiles so it can be restored on
      // dismount, but it is represented on the wire by the rider's Layer 25
      // item. Streaming the backing pet as an ordinary mobile creates the
      // second horse seen a few tiles behind the rider.
      if (!m || m === self || m.mounted || !inWorldLayer(center, m)) continue;
      if (inRange(center, m, range)) yield m;
    }
    return;
  }
  for (const mobile of legacyNearbyMobiles(world, center, self, range, inRange)) {
    if (inWorldLayer(center, mobile)) yield mobile;
  }
}

/**
 * Iterate items within range of center. Sector-indexed when the index
 * is fully populated (the index only buckets parent-less ground items,
 * so the parent gate is a defensive double-check).
 */
export function* nearbyItems(world, center, range = UPDATE_RANGE) {
  if (_itemsSectorsUsable(world)) {
    for (const serial of _sectorCandidates(world, 'item', center, range)) {
      const it = world.items.get(serial);
      if (!it || it.parent || it.visible === false || !inWorldLayer(center, it)) continue;
      if (inRange(center, it, range)) yield it;
    }
    return;
  }
  for (const item of legacyNearbyItems(world, center, range, inRange)) {
    if (inWorldLayer(center, item)) yield item;
  }
}
