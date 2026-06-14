// Line-of-sight calculation. Mirrors ServUO `Map.LineOfSight` and
// `Item.LineOfSight`. Used by spell targeting, ranged combat, AI
// aggression / fleeing, archery, and the "I see what you see" filter.
//
// Algorithm — 3D Bresenham:
//   1. Walk integer tile coords from source to target with the standard
//      x-major / y-major Bresenham step accumulator.
//   2. At each intermediate tile, compute the ray's z at that (x,y) by
//      lerping between source-eye-Z and target-eye-Z based on path
//      progress.
//   3. Reject the ray if ANY static at that tile has FLAG_IMPASSABLE
//      and its [z, z+height) span contains the ray's z.
//   4. Endpoints (source + target tile) are exempt — the caster's
//      tile and the victim's tile never self-occlude.
//
// We treat doors as passable (FLAG_DOOR), foliage as passable (FLAG_FOLIAGE),
// and bridges/surfaces as passable. Only IMPASSABLE non-door statics block.
//
// Eye height is +14 z-units above the standing tile — matches ServUO
// `Map.EyeHeight`. Tall (mounted) creatures see slightly higher; we use a
// flat constant for now to keep this self-contained.

import { landProvider } from './land-provider.js';

const FLAG_IMPASSABLE = 1 <<  6;
const FLAG_DOOR       = 1 << 29;
const FLAG_FOLIAGE    = 1 << 14;

const EYE_HEIGHT = 14;

let _staticHeightFn = null;
/** Install an injector that returns a static's height for a given tileId.
 *  Wired by main.js using the same tiledata source movement.js uses. We
 *  avoid duplicating the JSON load here to keep the module dependency-free. */
export function setStaticHeightResolver(fn) {
  _staticHeightFn = typeof fn === 'function' ? fn : null;
}
function heightOf(tileId) {
  return _staticHeightFn ? (_staticHeightFn(tileId) | 0) : 5;
}

/** Eye z for a mob at (x,y,z) — shoulder height. */
export function eyeZ(z) { return (z | 0) + EYE_HEIGHT; }

// ---- LOS cache --------------------------------------------------------
// Caches the answer per (facet|x0|y0|z0|x1|y1|z1) for ~100 ms. Combat
// pathways re-query LOS many times within a single AI step (target
// pick → swing reach → spell reach → flee LOS) and once per pulse for
// peerless cone effects — for the typical 5-mage burst we used to walk
// the Bresenham 25× per second per attacker, now we walk it once and
// fan the same answer out. TTL stays small so an evicting door / a
// moved-tile static doesn't lie for more than a frame.
const _losCache = new Map();   // key -> { result, exp }
const LOS_TTL_MS = 100;
const LOS_CACHE_CAP = 4096;
function losCacheKey(facet, x0, y0, z0, x1, y1, z1, checkSrc, checkDst) {
  // Tiny tagged hash → string. Boolean tag flags into the trailing
  // letters so the dispatcher doesn't conflate {checkSrc:true} and
  // {checkDst:true} pairs (different answer).
  return `${facet}|${x0},${y0},${z0}|${x1},${y1},${z1}|${checkSrc?1:0}${checkDst?1:0}`;
}

/**
 * @param {number} facet
 * @param {{x:number,y:number,z:number}} src
 * @param {{x:number,y:number,z:number}} dst
 * @param {{ checkSrcTile?: boolean, checkDstTile?: boolean }} [opts]
 * @returns {boolean}
 */
export function lineOfSight(facet, src, dst, opts = {}) {
  if (!src || !dst) return false;
  const x0 = src.x | 0, y0 = src.y | 0;
  const x1 = dst.x | 0, y1 = dst.y | 0;
  const z0 = eyeZ(src.z);
  const z1 = eyeZ(dst.z);
  const checkSrc = !!opts.checkSrcTile;
  const checkDst = !!opts.checkDstTile;
  const key = losCacheKey(facet, x0, y0, z0, x1, y1, z1, checkSrc, checkDst);
  const now = Date.now();
  const hit = _losCache.get(key);
  if (hit && hit.exp > now) return hit.result;

  const result = _computeLineOfSight(facet, x0, y0, z0, x1, y1, z1, checkSrc, checkDst);
  // Cap the cache before insertion to avoid unbounded growth on busy
  // shards. 4096 entries × ~80 bytes = ~320 KB, plenty for one frame's
  // distinct queries on a populated zone.
  if (_losCache.size >= LOS_CACHE_CAP) {
    // Cheap LRU-ish eviction: drop the oldest insertion (Map preserves
    // insertion order). Burst-then-clear so we don't pay this per-insert.
    const first = _losCache.keys().next().value;
    if (first !== undefined) _losCache.delete(first);
  }
  _losCache.set(key, { result, exp: now + LOS_TTL_MS });
  return result;
}

function _computeLineOfSight(facet, x0, y0, z0, x1, y1, z1, checkSrc, checkDst) {
  // Same-tile shortcut.
  if (x0 === x1 && y0 === y1) return true;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;

  // Total step count for z lerp — Chebyshev distance keeps the increment
  // proportional to either axis (8-direction tiles).
  const total = Math.max(dx, dy);
  if (total === 0) return true;

  let err = dx - dy;
  let x = x0, y = y0;
  let step = 0;

  while (x !== x1 || y !== y1) {
    const isSrc = (x === x0 && y === y0);
    if (!isSrc || checkSrc) {
      const t = step / total;
      const rayZ = Math.round(z0 + (z1 - z0) * t);
      if (tileBlocks(facet, x, y, rayZ)) return false;
    }
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 <  dx) { err += dx; y += sy; }
    step += 1;
    // Safety cap — UO maps are 7168×4096; LOS will never need that many
    // tile steps but a math error in caller arguments could spin forever.
    if (step > 256) return false;
  }
  if (checkDst) {
    if (tileBlocks(facet, x1, y1, z1)) return false;
  }
  return true;
}

// Optional: explicit cache invalidation hook for tests + door toggles +
// admin map edits. Cheap no-op when the cache is empty.
export function invalidateLosCache() { _losCache.clear(); }

/** True when any IMPASSABLE non-door static at (x,y) overlaps z. */
function tileBlocks(facet, x, y, z) {
  const statics = landProvider.staticsAt(facet, x, y);
  if (!statics || statics.length === 0) return false;
  for (const s of statics) {
    const flags = s.flags ?? 0;
    if (!(flags & FLAG_IMPASSABLE)) continue;
    if (flags & FLAG_DOOR) continue;
    if (flags & FLAG_FOLIAGE) continue;
    const top = (s.z | 0) + heightOf(s.tileId);
    // Strict overlap: ray AT s.z is "on top of" the static and passes;
    // ray strictly inside the span is blocked.
    if (z > s.z && z < top) return true;
  }
  return false;
}
