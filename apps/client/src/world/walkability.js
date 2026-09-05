// Client-side standing-Z resolver. Mirror of the server's
// `resolveStandingZ`/`resolveCardinalStep` math at MVP scope so the
// player's avatar can compute its OWN new z right after a 0x22
// movementAck — the ack carries no z field, and waiting for the
// server's broadcast (0x77 to nearby observers, never echoed back to
// self in vanilla ServUO) makes the sprite slide flat across stairs
// before snapping up. We re-resolve locally to produce the dz lerp.
//
// We rely on the same `assets.landAt` + `assets.staticsAt` data that
// the renderer already pulled. tiledata flags decide which statics
// contribute as surfaces.

import { assets } from '../assets/asset-manager.js';
import { world } from './world.js';

// Subset of ServUO TileFlag bits we need.
const FLAG_IMPASSABLE = 0x00000040;
const FLAG_SURFACE    = 0x00000200;
const FLAG_BRIDGE     = 0x00000400;     // stairs project mover up by height/2

const PERSON_HEIGHT = 16;
// Match the server's `STEP_HEIGHT = 5` (movement.js:55). When the
// client predicted climb=2 but the server allowed climb=5, every
// real-world stair (3+ z-delta between treads) was rejected by the
// client's local Z resolver — `resolveLocalStandingZ` returned
// `fromZ`, the avatar slid flat across the tile, and only on the
// next 0x77 self-broadcast did the server's higher Z snap into the
// sprite. Players reported "stairs don't work" because the visual
// climb never happened.
const MAX_CLIMB     = 5;
// MAX_DROP raised in lockstep — the server has no explicit drop limit
// (movement.js:59 sets MAX_DROP = 127); keeping the client at 8 made
// any cliff / balcony / roof edge un-traversable from the client's
// own walkability prediction even when the server happily accepted
// the move. Use 20 (the standard "tall building" drop in CUO).
const MAX_DROP      = 20;

function staticInfo(id) {
  const s = assets.tiledata?.statics?.[id | 0];
  if (!s) return { flags: 0, height: 0 };
  return { flags: s.flags | 0, height: s.height | 0 };
}

function calcHeight(info) {
  const h = info.height | 0;
  return (info.flags & FLAG_BRIDGE) ? (h >> 1) : h;
}

function isBetterCandidate(prevZ, bestZ, bestDist, z) {
  const d = Math.abs(z - prevZ);
  return d < bestDist || (d === bestDist && z > bestZ);
}

/** Audit #35 F6 — yield dynamic-item rows on (tx, ty, map) that the
 *  pathfinder needs to honour (closed doors, locked chests, gravestones).
 *  CUO `Pathfinder.cs::CreateItemList` enumerates `World.Items` per
 *  tile. Was: walkability only consulted baked statics, so click-walk
 *  routes ran straight through closed doors and the server's blocker
 *  desync-snapped the player back. */
function forEachNearbyDynamicItem(tx, ty, map, visit) {
  const mapId = map ?? 1;
  if (typeof world?.forEachItemNear === 'function') {
    world.forEachItemNear(tx, ty, mapId, 0, visit);
    return;
  }
  const nearby = world?.itemsNear
    ? world.itemsNear(tx, ty, mapId, 0)
    : (world?.itemsAt ? world.itemsAt(tx, ty, mapId, 0) : null);
  if (!nearby) return;
  for (const it of nearby) {
    if (visit(it) === false) break;
  }
}

/**
 * Local mirror of the server's `resolveStep` blocker test. Returns true
 * when the client's copy of the tile data clearly shows the destination
 * is impassable — i.e. an impassable + non-surface static occupies
 * (tx,ty), OR no surface is within climb/drop budget of `fromZ`. Used
 * by `_sendMove` to refuse client-side prediction when we already
 * know the server would reject. Stops the visual "walk through wall"
 * flicker that happens when the client predicts a rejected step and
 * snaps back ~50-200 ms later. The apparent collision bypass was this prediction
 * window, not a real collision bug — server was correctly rejecting.
 *
 * Returns `false` (don't block) when the local data is missing or
 * ambiguous: prefer to send the 0x02 and let the authoritative server
 * decide. False-positives are worse than false-negatives because they
 * trap players on map edges where chunk data hasn't streamed yet.
 */
export function isLocallyBlocked(tx, ty, fromZ, map = 1) {
  // Resolve the floor first, then test the body at the height on which it
  // would actually stand. Testing every blocker against `fromZ` trapped the
  // player at the last tread of many canonical staircases: a 3-unit wall
  // skirt occupies z=30..33, the source tread is z=32 and the destination
  // floor is z=33. Against z=32 the skirt overlaps by one unit; against the
  // real destination body (z=33..) it is correctly flush and harmless. The
  // authoritative ServUO resolver performs the candidate-floor selection
  // before its AABB clearance test, so mirror that ordering here.
  const standingZ = resolveLocalStandingZ(tx, ty, fromZ, map);
  const bodyTop = standingZ + PERSON_HEIGHT;
  // Hard impassable static — closed doors, walls, chests with no
  // surface flag. If found, the tile is unconditionally unwalkable.
  let blocked = false;
  forEachNearbyDynamicItem(tx, ty, map, (it) => {
    if (it.x !== tx || it.y !== ty) return undefined;
    const info = staticInfo(it.itemId | 0);
    const isSurface = (info.flags & FLAG_SURFACE) !== 0;
    const isImpassable = (info.flags & FLAG_IMPASSABLE) !== 0;
    if (isImpassable && !isSurface) {
      // BUT: open doors have `it.door.isOpen === true` and become
      // passable. Mirrors server `runtimeSolidAt` gate.
      if (it.door && it.door.isOpen) return undefined;
      const itemZ = it.z | 0;
      const itemTop = itemZ + Math.max(1, calcHeight(info));
      if (itemTop > standingZ && bodyTop > itemZ) {
        blocked = true;
        return false;
      }
    }
    return undefined;
  });
  if (blocked) return true;
  // Walk static tiles too — wall pieces, closed gate sprites, etc.
  const cx = tx >> 3, cy = ty >> 3;
  const list = assets.staticsAt(cx, cy) ?? [];
  const lx = tx & 7, ly = ty & 7;
  for (const s of list) {
    if (s.x !== lx || s.y !== ly) continue;
    const info = staticInfo(s.id);
    const isSurface = (info.flags & FLAG_SURFACE) !== 0;
    const isImpassable = (info.flags & FLAG_IMPASSABLE) !== 0;
    if (isImpassable && !isSurface) {
      // Body span vs static span — only block if vertical overlap exists.
      const h = calcHeight(info);
      const staticTop = s.z + h;
      if (staticTop > standingZ && bodyTop > s.z) return true;
    }
  }
  // No explicit blocker. Could still be unreachable (no surface at
  // any climbable Z) — but those cases also pass server resolveStep
  // most of the time (movement.js falls back to land Z). Be lenient.
  return false;
}

/**
 * Return the standing-Z for (tx, ty) closest to `fromZ`. When two
 * surfaces are equidistant prefer the higher one — matches ServUO's
 * "stand on top of" bias for new arrivals. Returns `fromZ` if no
 * walkable surface exists (renderer falls back to old z visually).
 */
export function resolveLocalStandingZ(tx, ty, fromZ, map = 1) {
  const land = assets.landAt(tx, ty);
  let anyCount = 0;
  let reachCount = 0;
  let bestAnyZ = fromZ;
  let bestAnyDist = Infinity;
  let bestReachZ = fromZ;
  let bestReachDist = Infinity;

  if (land) {
    const z = land.z | 0;
    anyCount++;
    if (isBetterCandidate(fromZ, bestAnyZ, bestAnyDist, z)) {
      bestAnyZ = z;
      bestAnyDist = Math.abs(z - fromZ);
    }
    if (z - fromZ <= MAX_CLIMB && fromZ - z <= MAX_DROP) {
      reachCount++;
      if (isBetterCandidate(fromZ, bestReachZ, bestReachDist, z)) {
        bestReachZ = z;
        bestReachDist = Math.abs(z - fromZ);
      }
    }
  }
  // Audit #35 F6 — fold in dynamic items. Closed doors / locked chests
  // /etc. are IMPASSABLE+!SURFACE — if any such item sits on the tile,
  // the tile itself is unwalkable and the pathfinder must route around
  // it. Returning `fromZ` here cooperates with the climb-budget filter
  // (caller falls back to "no walkable surface").
  let dynamicBlocked = false;
  forEachNearbyDynamicItem(tx, ty, map, (it) => {
    if (it.x !== tx || it.y !== ty) return undefined;
    const info = staticInfo(it.itemId | 0);
    const isSurface = (info.flags & FLAG_SURFACE) !== 0;
    const isBridge  = (info.flags & FLAG_BRIDGE) !== 0;
    const isImpassable = (info.flags & FLAG_IMPASSABLE) !== 0;
    if (isImpassable && !isSurface) {
      dynamicBlocked = true;
      return false;
    }
    if (isSurface || isBridge) {
      const z = (it.z | 0) + calcHeight(info);
      anyCount++;
      if (isBetterCandidate(fromZ, bestAnyZ, bestAnyDist, z)) {
        bestAnyZ = z;
        bestAnyDist = Math.abs(z - fromZ);
      }
      if (z - fromZ <= MAX_CLIMB && fromZ - z <= MAX_DROP) {
        reachCount++;
        if (isBetterCandidate(fromZ, bestReachZ, bestReachDist, z)) {
          bestReachZ = z;
          bestReachDist = Math.abs(z - fromZ);
        }
      }
    }
    return undefined;
  });
  if (dynamicBlocked) return fromZ;
  const cx = tx >> 3, cy = ty >> 3;
  const list = assets.staticsAt(cx, cy) ?? [];
  const lx = tx & 7, ly = ty & 7;
  for (const s of list) {
    if (s.x !== lx || s.y !== ly) continue;
    const info = staticInfo(s.id);
    const isSurface = (info.flags & FLAG_SURFACE) !== 0;
    const isBridge  = (info.flags & FLAG_BRIDGE) !== 0;
    const isImpassable = (info.flags & FLAG_IMPASSABLE) !== 0;
    // Suppinfo augmentation: when tiledata flags say "not a surface" but
    // suppinfo.directSupports === 1, the tile IS walkable per CUO's
    // custom-house pathing tables. Mirrors CUO `CustomHouseObject.IsTileFinished`
    // semantics — there are retail UO tiles whose flags don't match
    // their authoring intent. Likewise, the suppinfo `top` field gives
    // a more accurate stand-on Z than tiledata.height for stair / bridge
    // pieces with tilted geometry.
    const supp = assets.suppInfo?.(s.id);
    const suppSurface = supp && supp.directSupports === 1;
    if (isImpassable && !isSurface && !suppSurface) continue;
    if (!isSurface && !isBridge && !suppSurface) continue;
    // Prefer suppinfo `top` when present — it represents the actual
    // walking-surface offset (CUO's StaticTileInfo.Top). Fallback to
    // calcHeight which combines bridge / non-bridge halving rules.
    const heightFromSupp = supp?.top != null ? supp.top : calcHeight(info);
    const z = (s.z + heightFromSupp) | 0;
    anyCount++;
    if (isBetterCandidate(fromZ, bestAnyZ, bestAnyDist, z)) {
      bestAnyZ = z;
      bestAnyDist = Math.abs(z - fromZ);
    }
    if (z - fromZ <= MAX_CLIMB && fromZ - z <= MAX_DROP) {
      reachCount++;
      if (isBetterCandidate(fromZ, bestReachZ, bestReachDist, z)) {
        bestReachZ = z;
        bestReachDist = Math.abs(z - fromZ);
      }
    }
  }
  if (reachCount) return bestReachZ;
  return anyCount ? bestAnyZ : fromZ;
}
