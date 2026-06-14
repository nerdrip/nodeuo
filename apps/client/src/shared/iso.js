// Isometric projection helpers. Mirrors ClassicUO's tile geometry:
//   - a land tile is a 44×44 diamond (so the *visible* tile half-extents
//     are 22 wide × 22 tall in screen space)
//   - tile X axis: NE in world ↔ +X +Y on screen
//   - tile Y axis: SW in world ↔ −X +Y on screen
//   - elevation (Z): each Z unit lifts the tile 4 px on screen
//
// World coords are tile-indexed integers (0..mapWidth-1). Pixel-space is
// what we hand to Pixi as Container.position values.
//
// SHARED MODULE: imported by both the in-game client (Pixi renderer) and
// the admin web editor (DOM-only canvas painter). NO Pixi / Node / DOM
// imports — just numbers in, numbers out. Anything that depends on a
// runtime surface goes in the consuming surface's renderer, not here.

export const TILE_W = 44;
export const TILE_H = 44;
export const TILE_HALF_W = TILE_W / 2;
export const TILE_HALF_H = TILE_H / 2;
export const Z_STEP = 4;

/** Project only screen-space X. Allocation-free hot-path helper. */
export function worldToScreenX(tileX, tileY) {
  return (tileX - tileY) * TILE_HALF_W;
}

/** Project only screen-space Y. Allocation-free hot-path helper. */
export function worldToScreenY(tileX, tileY, tileZ = 0) {
  return (tileX + tileY) * TILE_HALF_H - tileZ * Z_STEP;
}

/** Project into an existing object to avoid per-frame `{ x, y }` churn. */
export function worldToScreenInto(out, tileX, tileY, tileZ = 0) {
  out.x = worldToScreenX(tileX, tileY);
  out.y = worldToScreenY(tileX, tileY, tileZ);
  return out;
}

/**
 * Project a world tile center to its screen-space position.
 * @param {number} tileX
 * @param {number} tileY
 * @param {number} [tileZ]
 * @returns {{ x:number, y:number }}
 */
export function worldToScreen(tileX, tileY, tileZ = 0) {
  return {
    x: worldToScreenX(tileX, tileY),
    y: worldToScreenY(tileX, tileY, tileZ),
  };
}

/**
 * Inverse projection (assumes flat ground at given z). Useful for
 * mouse → tile lookups.
 * @param {number} sx  screen-space X (already adjusted for camera)
 * @param {number} sy
 * @param {number} [tileZ]
 * @returns {{ x:number, y:number }}
 */
export function screenToWorld(sx, sy, tileZ = 0) {
  const ay = sy + tileZ * Z_STEP;
  const fx = sx / TILE_HALF_W;
  const fy = ay / TILE_HALF_H;
  return { x: (fy + fx) / 2, y: (fy - fx) / 2 };
}

/**
 * Sort key for back-to-front draw order. ClassicUO sorts by:
 *   primary   = (tileX + tileY)   — iso row, distance from camera
 *   secondary = layer offset      — land < static < item < mobile < effect
 *   tertiary  = tileZ             — vertical stack within the layer
 *
 * Encoding: (X+Y)*65536 + layer*256 + (Z+128).
 *
 * The earlier formula `(X+Y)*4096 + (Z+128)*16 + layer` had the layer
 * priority weighing only 1 while Z weighed 16 — meaning a stretched
 * land tile whose `avgZ` was even 1 unit above a same-tile static's
 * `priorityZ` rendered ON TOP OF the static. Visible at:
 *   • coastline water (water -1 bias outvoted shore decorations)
 *   • Britain Bank floor (avgZ=3 land beat z=0 carpets)
 *   • dungeon ramps (slope avgZ swallowed stair statics)
 *
 * New ordering puts layer above any plausible Z delta (LAYER_STATIC=4
 * → 1024 lead, no Z value flips it) so same-row statics ALWAYS render
 * in front of land, while still preserving Z for in-layer stacking
 * (a tall static at z=10 beats a flat static at z=2 by 8). Z biased
 * by +128 so negative ocean elevations stay positive for the comparator.
 *
 * Layer fits in 0..255; we use 0..12. Per-row capacity is 65536, ample
 * for layer*256 + Z+128 without overflow into the next row.
 */
export function depthKey(tileX, tileY, tileZ = 0, layer = 1) {
  return (tileX + tileY) * 65536 + (layer & 0xff) * 256 + (tileZ + 128);
}

/** Convenience layers used by the renderer. */
export const LAYER_LAND   = 0;
export const LAYER_STATIC = 4;
export const LAYER_ITEM   = 6;
export const LAYER_MOBILE = 8;
export const LAYER_EFFECT = 12;
