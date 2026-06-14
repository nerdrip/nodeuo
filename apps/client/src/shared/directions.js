// UO 8-direction compass. Mirrors CUO `Direction` enum (`Game/Data/Directions.cs`)
// and ServUO `Server/Direction.cs` — both use the same N=0..NW=7 numbering
// so movement packets travel intact across client ↔ server.
//
// SHARED MODULE: numbers + small helpers. No fetch, no DOM, no Pixi. Imported
// by walker, mobile-renderer, ai, pathfinder, net handlers.

export const DIR_NORTH     = 0;
export const DIR_NORTHEAST = 1;
export const DIR_EAST      = 2;
export const DIR_SOUTHEAST = 3;
export const DIR_SOUTH     = 4;
export const DIR_SOUTHWEST = 5;
export const DIR_WEST      = 6;
export const DIR_NORTHWEST = 7;

/** Bit set on `direction` byte in 0x97 MoveTo / 0x02 MovementReq when the
 *  mobile is running rather than walking. Step duration on the renderer
 *  uses this to pick 100 ms (run) vs 200 ms (walk). */
export const DIR_RUNNING_BIT = 0x80;
export const DIR_MASK        = 0x07;

/** Per-direction (dx, dy) tile delta. Index by `dir & 7` so a packet
 *  with the running bit set still indexes correctly. */
export const DIR_DX = Object.freeze([ 0, +1, +1, +1,  0, -1, -1, -1]);
export const DIR_DY = Object.freeze([-1, -1,  0, +1, +1, +1,  0, -1]);

/** Human-readable 8-name labels for UI / log lines. */
export const DIR_NAMES = Object.freeze([
  'north', 'northeast', 'east', 'southeast',
  'south', 'southwest', 'west', 'northwest',
]);

/** Pick a direction from a screen / tile vector. Returns 0..7. Uses
 *  CUO's atan2 → octant mapping (PaperDoll cursor + AI step rely on
 *  the same rounding so the choice of which cardinal a near-diagonal
 *  step prefers is consistent across surfaces). */
export function directionFromDelta(dx, dy) {
  const angle = Math.atan2(dy, dx);
  // Octant 0 is east in screen-space; UO direction 0 is north. The +10
  // bias rotates by 90° (so screen-east aligns with UO direction 2) and
  // keeps the modulo positive across all real-world inputs.
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

/** Step (dx, dy) for a packed `direction` byte (with optional run bit). */
export function stepFor(direction) {
  const d = direction & DIR_MASK;
  return { dx: DIR_DX[d], dy: DIR_DY[d] };
}

/** Whether the direction byte represents a running step (vs walking). */
export function isRunning(direction) {
  return (direction & DIR_RUNNING_BIT) !== 0;
}
