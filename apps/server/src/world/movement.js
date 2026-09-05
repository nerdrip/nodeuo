// Walkability / step-resolution for mobile movement.
//
// Ports the canonical ServUO `MovementImpl.Check` + `IsOk` + `GetStartZ` +
// `Map.GetAverageZ` from Scripts/Services/Pathing/Movement.cs and Server/Map.cs.
// The algorithm:
//
//   1. `getAverageZ(x, y)` returns the destination land tile's 4-corner stats
//      `{z (low), avg (center), top (high)}`. The mover stands at `avg` on a
//      sloped land tile so server collision matches the stretched render the
//      player sees. Without this, every shoreline / hill step rubber-bands.
//
//   2. `getStartZ` walks the surface stack the mover currently stands on and
//      returns `[startZ, startTop]`. `startZ` is the standing-Z of the highest
//      supporting surface (= landAvg if standing on land); `startTop` is the
//      RAW top of that stack — bridges contribute FULL height, land
//      contributes its highest corner. That's the climb budget for stairs and
//      lets the mover step from a low corner up onto the next tile.
//
//   3. `stepTop = startTop + StepHeight` is the climb budget. For every
//      Surface candidate at the destination we require `stepTop >= itemTop`,
//      where `itemTop = item.z + (Bridge ? 0 : Height)`. Bridges have
//      effective height 0 in the gate — any bridge whose base sits at or
//      below `stepTop` is climbable.
//
//   4. `ourZ = item.z + CalcHeight` (Bridge ? Height/2 : Height) is the
//      mover's standing-Z on a static. The land candidate uses `landAvg`.
//
//   5. ServUO's "buried-in-land" filter: a static is rejected when stepping
//      a small amount up its base doesn't clear the land's average AND the
//      land's low corner intrudes into the body span — otherwise the mover
//      lands UNDER the terrain.
//
//   6. `IsOk` checks for vertical AABB overlap between the body span
//      `[ourZ, max(startZ+16, ourZ+16))` and every Impassable|Surface tile
//      at the destination (using CalcHeight for the obstacle, which is what
//      blocks "walking under stairs").
//
// Without tiledata we fall back to land-only walking so the server never
// strands a player.

import { landProvider } from './land-provider.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Character vertical footprint — blocks above the floor must be clear. */
const PERSON_HEIGHT = 16;
/** Maximum z you can climb in one ordinary step.
 *  ServUO ships a StepHeight of 2, but on real UO terrain that produces
 *  the "stops on every minor bump" feel — most natural slopes (paths,
 *  shorelines, hill faces) have z deltas of 3–5 between adjacent tiles.
 *  We use 5 to match what feels right in-game while still rejecting any
 *  obviously-cliff transition (the test harness still expects climb=10
 *  to be blocked). */
const STEP_HEIGHT = 5;
/** Maximum z you can drop in one step. ServUO has no explicit drop limit
 *  (characters fall arbitrarily); we keep one for sanity but make it large
 *  enough that walking off any normal building/bridge isn't blocked. */
const MAX_DROP = 127;

const DEFAULT_TILEDATA = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'client', 'public', 'assets', 'tiledata.json',
);

/** Tile flag bits we actually care about. CUO TileDataLoader.cs:404. */
const FLAG_IMPASSABLE = 1 <<  6; // 0x40 — block movement
const FLAG_WET        = 1 <<  7; // 0x80 — water; unswimmable on foot
const FLAG_SURFACE    = 1 <<  9; // 0x200
const FLAG_BRIDGE     = 1 << 10; // 0x400 — stairs
const FLAG_DOOR       = 1 << 29;

let TILEDATA = null;
export async function preloadTileData(file = DEFAULT_TILEDATA) {
  if (TILEDATA !== null) return TILEDATA;
  try { TILEDATA = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
  catch { TILEDATA = { land: [], statics: [] }; }
  return TILEDATA;
}
function loadTileData() {
  if (TILEDATA !== null) return TILEDATA;
  try {
    TILEDATA = JSON.parse(fs.readFileSync(DEFAULT_TILEDATA, 'utf8'));
  } catch {
    TILEDATA = { land: [], statics: [] };
  }
  return TILEDATA;
}

/** Public accessor for the static height table — used by LOS. */
export function staticHeightFor(tileId) {
  const td = loadTileData();
  return td.statics?.[tileId]?.height | 0;
}

/** Expose the parsed tiledata table for admin tools (search palette,
 *  inspector). The two arrays are large (16384 land + 65536 statics)
 *  so callers should paginate or filter at use time, not iterate raw. */
export function tileDataTable() {
  return loadTileData();
}

/** Public accessor for the static weight table — used by inventory
 *  load calc. Tiledata weights are byte values 0..255. ServUO treats
 *  255 as "non-pickupable" (sentinel for unmovables); we surface that
 *  via 0 so totalWeight rolls up the rest cleanly. */
export function staticWeightFor(tileId) {
  const td = loadTileData();
  const w = td.statics?.[tileId]?.weight | 0;
  return w === 255 ? 0 : w;
}

function staticInfo(tileId) {
  const td = loadTileData();
  // CUO indexes `_staticData[graphic]` directly with the raw tileId
  // from statics.mul (Art.cs:34 only adds 0x4000 for ART lookups, NOT
  // for tiledata). Because of UO's quirky data layout the same id
  // resolves to a different sprite vs. a different tiledata entry —
  // for movement we need the BEHAVIOURAL row (raw idx).
  const entry = td.statics?.[tileId];
  if (!entry) return { flags: 0, height: 0 };
  return { flags: entry.flags | 0, height: entry.height | 0 };
}

function landInfo(tileId) {
  const td = loadTileData();
  const entry = td.land?.[tileId];
  if (!entry) return { flags: 0 };
  return { flags: entry.flags | 0 };
}

/** ServUO `Map.FloorAverage` — integer floor toward -inf for the (a+b)/2. */
function floorAverage(a, b) {
  let v = a + b;
  if (v < 0) v -= 1;
  return (v / 2) | 0;
}

/**
 * ServUO `Map.GetAverageZ`. Returns the four-corner stats for the land tile
 * at (x, y): `{ z: low, avg: center, top: high }`. The mover stands at `avg`
 * on a sloped land tile, NOT at the stored z — that's what makes shoreline
 * and hillside walking feel right (and what matches CUO's stretched render).
 *
 * Corner naming (ServUO terms):
 *   zTop    = land(x,   y  )   — the cell's stored z
 *   zRight  = land(x+1, y  )
 *   zLeft   = land(x,   y+1)
 *   zBottom = land(x+1, y+1)
 *
 * `avg` picks the diagonal that's flatter and averages the OTHER diagonal —
 * giving the true center of the sloped quad. Falls back to the source z
 * when a neighbour chunk hasn't loaded (treats the tile as flat) so the
 * synthetic test layouts and unloaded-frontier streaming don't break.
 */
function getAverageZ(facet, x, y) {
  const self = landProvider.landAt(facet, x, y);
  if (!self) return null;
  const fb = self.z;
  const zTop    = self.z;
  const zRight  = landProvider.landAt(facet, x + 1, y    )?.z ?? fb;
  const zLeft   = landProvider.landAt(facet, x,     y + 1)?.z ?? fb;
  const zBottom = landProvider.landAt(facet, x + 1, y + 1)?.z ?? fb;

  let z = zTop;
  if (zLeft   < z) z = zLeft;
  if (zRight  < z) z = zRight;
  if (zBottom < z) z = zBottom;

  let top = zTop;
  if (zLeft   > top) top = zLeft;
  if (zRight  > top) top = zRight;
  if (zBottom > top) top = zBottom;

  const avg = Math.abs(zTop - zBottom) > Math.abs(zLeft - zRight)
    ? floorAverage(zLeft, zRight)
    : floorAverage(zTop, zBottom);

  return { z, avg, top };
}

/** ServUO `ItemData.CalcHeight`: bridges (stairs) project the mover up by
 *  height/2 (integer floor); everything else by full height. Used for both
 *  the candidate's standing-Z and for IsOk's obstacle span. */
function calcHeight(info) {
  const h = info.height | 0;
  return (info.flags & FLAG_BRIDGE) ? (h >> 1) : h;
}

/**
 * ServUO `MovementImpl.GetStartZ`. Returns `{ startZ, startTop }` for the
 * mover currently standing at (x, y, z). `startTop` is the TOP of the
 * surface stack (raw height, NOT CalcHeight) — that's what gives stairs
 * their climb budget: a bridge with height=10 has CalcHeight=5 (so you
 * stand at z+5) but contributes z+10 to startTop, so stepTop = z+10+2 = z+12
 * is what's compared against the next stair's base.
 */
function getStartZ(facet, x, y, z) {
  let zLow = z;
  let zTop = z;
  let zCenter = -Infinity;
  let isSet = false;

  const land = landProvider.landAt(facet, x, y);
  // ServUO: standing on land uses the 4-corner AVERAGE as zCenter (so a
  // sloped tile's "stand-Z" matches the stretched render the player sees),
  // and the highest corner contributes to zTop (the stair-climb budget).
  const avg = land ? getAverageZ(facet, x, y) : null;
  if (avg && z >= avg.avg) {
    zLow = avg.z;
    zCenter = avg.avg;
    zTop = Math.max(zTop, avg.top);
    isSet = true;
  }

  for (const s of landProvider.staticsAt(facet, x, y)) {
    const info = staticInfo(s.tileId);
    if (!(info.flags & (FLAG_SURFACE | FLAG_BRIDGE))) continue;
    const ch = calcHeight(info);
    const calcTop = s.z + ch;
    // Only items the mover is at-or-above contribute to the support stack.
    if (z < calcTop) continue;
    if (!isSet || calcTop >= zCenter) {
      zLow = s.z;
      zCenter = calcTop;
      zTop = Math.max(zTop, s.z + (info.height | 0)); // raw height for the TOP
      isSet = true;
    }
  }

  if (_runtimeSurfaceAt) {
    for (const s of _runtimeSurfaceAt(facet, x, y)) {
      const height = Math.max(0, s.height | 0);
      const calcTop = (s.z | 0) + (s.bridge ? (height >> 1) : height);
      if (z < calcTop) continue;
      if (!isSet || calcTop >= zCenter) {
        zLow = s.z | 0;
        zCenter = calcTop;
        zTop = Math.max(zTop, (s.z | 0) + height);
        isSet = true;
      }
    }
  }

  if (!isSet) {
    zLow = zTop = z;
  } else if (z > zTop) {
    zTop = z;
  }
  return { startZ: zLow, startTop: zTop };
}

/**
 * ServUO `MovementImpl.IsOk`. Returns true when the mover may legally
 * stand at (x,y,ourZ) with body span `[ourZ, ourTop)`.
 *
 * The check: for EVERY static at (x,y) flagged Impassable OR Surface,
 * its vertical span [tile.z, tile.z + CalcHeight) must NOT overlap the
 * mover's body span. Equality at the boundary is allowed (you can stand
 * flush on top).
 *
 * `ourTop` is supplied by the caller as `max(checkTop, ourZ + PERSON_HEIGHT)`
 * where `checkTop = startZ + PERSON_HEIGHT`. This matches ServUO and means
 * stepping DOWN onto a surface still checks clearance up to the source's
 * head-height — important for low ceilings at the source side.
 */
function isOk(facet, x, y, ourZ, ourTop) {
  for (const s of landProvider.staticsAt(facet, x, y)) {
    const info = staticInfo(s.tileId);
    // ServUO's ImpassableSurface = Impassable | Surface. Bridges have
    // Surface set so they're included via this mask too.
    if (!(info.flags & (FLAG_IMPASSABLE | FLAG_SURFACE | FLAG_BRIDGE))) continue;
    // Doors are passable in our model — skip them when checking clearance.
    if (info.flags & FLAG_DOOR) continue;
    const ch = calcHeight(info);
    const checkZ = s.z;
    const checkTop = checkZ + ch;
    // AABB vertical overlap (strict: equality means flush, not overlapping).
    if (checkTop > ourZ && ourTop > checkZ) return false;
  }
  // PHASE AY: scan runtime-spawned solid items at the destination tile.
  // Closed doors (item.door.isOpen === false) and explicitly solid
  // items (item.solid === true) block. The `runtimeSolidAt` resolver
  // is wired by main.js at boot — it indexes items by tile so we
  // don't pay an O(N) cost on every step.
  // PHASE BD: Z-aware overlap. Closed doors / solid items only block
  // when their vertical span actually overlaps the mover's body. A
  // closed cellar door at z=-10 must not block an upper-floor walker
  // at z=20. Use the same AABB rule as the static check (strict
  // equality = flush, no overlap).
  const blocker = _runtimeSolidAt;
  if (blocker) {
    for (const it of blocker(facet, x, y)) {
      const blocks = (it.door && !it.door.isOpen) || it.solid;
      if (!blocks) continue;
      const itZ = (it.z | 0);
      // Doors are typically 20 z-units tall; a generic solid item
      // defaults to its `height` field or 5. The "person" body span
      // matches the static-check PERSON_HEIGHT used elsewhere.
      const itTop = itZ + (it.height ?? (it.door ? 20 : 5));
      if (itTop > ourZ && ourTop > itZ) return false;
    }
  }
  if (_runtimeSurfaceAt) {
    for (const it of _runtimeSurfaceAt(facet, x, y)) {
      const itZ = it.z | 0;
      const height = Math.max(0, it.height | 0);
      const itTop = itZ + (it.bridge ? (height >> 1) : height);
      if (itTop > ourZ && ourTop > itZ) return false;
    }
  }
  return true;
}

/** @type {((facet:number, x:number, y:number) => Iterable<any>) | null} */
let _runtimeSolidAt = null;
/** @type {((facet:number, x:number, y:number) => Iterable<any>) | null} */
let _runtimeSurfaceAt = null;

/**
 * Install a runtime solid-item resolver. Called once from main.js with
 * a function that returns iteration-friendly items at (facet,x,y).
 * Hidden behind a setter so movement.js stays free of a `world` import
 * — matches the existing landProvider injection pattern.
 */
export function setRuntimeSolidAt(fn) {
  _runtimeSolidAt = typeof fn === 'function' ? fn : null;
}

export function setRuntimeSurfaceAt(fn) {
  _runtimeSurfaceAt = typeof fn === 'function' ? fn : null;
}

/**
 * Evaluate a single-axis step to `(nx, ny)` from `(x, y, z)`. Returns the
 * resolved destination z (mover's standing-Z) or null if blocked.
 *
 * Algorithm matches ServUO `MovementImpl.Check`:
 *   stepTop  = startTop + StepHeight
 *   checkTop = startZ + PersonHeight
 *   for each Surface candidate at dest:
 *     itemTop = item.z + (Bridge ? 0 : raw Height)
 *     ourZ    = item.z + CalcHeight  (Bridge ? Height/2 : Height)
 *     ourTop  = max(checkTop, ourZ + PersonHeight)
 *     if stepTop < itemTop: skip (can't reach over the obstacle's top)
 *     if !IsOk(ourZ, ourTop): skip
 *     accept (tie-break: prefer candidate whose ourZ is closest to source z)
 */
function resolveCardinalStep(facet, x, y, z, nx, ny) {
  const { startZ, startTop } = getStartZ(facet, x, y, z);
  const stepTop = startTop + STEP_HEIGHT;
  const checkTop = startZ + PERSON_HEIGHT;

  const land = landProvider.landAt(facet, nx, ny);
  const destinationStatics = landProvider.staticsAt(facet, nx, ny);
  const runtimeSurfaces = _runtimeSurfaceAt
    ? [...(_runtimeSurfaceAt(facet, nx, ny) ?? [])]
    : [];
  // No land block loaded yet — be permissive so the player isn't stranded.
  // Runtime floors still need normal step/collision resolution even when the
  // underlying map chunk is absent (custom houses may legitimately bridge it).
  if (!land && destinationStatics.length === 0 && runtimeSurfaces.length === 0) return z;

  // ServUO: pre-compute the destination's 4-corner stats once. landAvg is
  // what the mover stands at if they accept the land candidate; landZ
  // gates the static-buried-in-land filter.
  const destAvg = land ? getAverageZ(facet, nx, ny) : null;
  const considerLand = !!land;
  const landZ      = destAvg ? destAvg.z   : 0;
  const landCenter = destAvg ? destAvg.avg : 0;

  let bestZ = null;
  let bestDist = Infinity;

  const tryCandidate = (itemZ, height, isBridge) => {
    const itemTop = itemZ + (isBridge ? 0 : height);
    if (stepTop < itemTop) return;
    if (z - itemTop > MAX_DROP) return; // dropped too far in one step
    const ourZ = itemZ + (isBridge ? (height >> 1) : height);
    const testTop = Math.max(checkTop, ourZ + PERSON_HEIGHT);

    // ServUO `Check`: a static is "buried" in the land if the small step up
    // its base (clamped to StepHeight) doesn't clear the land's average,
    // the land sits above where we'd stand on it, AND the land's low corner
    // is inside our body span. Skip such candidates — they'd put the mover
    // *under* the terrain.
    const landCheck = itemZ + Math.min(height, STEP_HEIGHT);
    if (considerLand && landCheck < landCenter && landCenter > ourZ && testTop > landZ) {
      return;
    }

    if (!isOk(facet, nx, ny, ourZ, testTop)) return;
    const dist = Math.abs(ourZ - z);
    // ServUO tie-break: closer to source z wins; on equal distance, the
    // LOWER candidate wins (you don't randomly land on top of a railing
    // when the floor is the same step away).
    if (bestZ === null || dist < bestDist || (dist === bestDist && ourZ < bestZ)) {
      bestDist = dist;
      bestZ = ourZ;
    }
  };

  for (const s of destinationStatics) {
    const info = staticInfo(s.tileId);
    // ServUO `Check` candidate filter: `(flags & ImpassableSurface) ==
    // TileFlag.Surface` — Surface bit set AND Impassable bit NOT set.
    // This excludes `Impassable|Surface` decorations (bed legs, low
    // railings, ceiling-trim stubs, chair frames) from being treated as
    // walkable landings — otherwise the mover lands on top of one and gets
    // stranded because every neighbouring step then fails IsOk against the
    // obstacle's full vertical span. Bridges have Surface (no Impassable)
    // so they pass this filter naturally.
    const isWalkable = (info.flags & FLAG_SURFACE) !== 0
                    && (info.flags & FLAG_IMPASSABLE) === 0;
    const isDoor = (info.flags & FLAG_DOOR) !== 0;
    if (!isWalkable && !isDoor) continue;
    tryCandidate(s.z, info.height | 0, (info.flags & FLAG_BRIDGE) !== 0);
  }
  for (const s of runtimeSurfaces) {
    tryCandidate(s.z | 0, Math.max(0, s.height | 0), s.bridge === true);
  }

  // Land is checked LAST in ServUO — after every static — and only if the
  // climb budget reaches the land's lowest corner. The mover stands at the
  // averaged center, not at any single corner, so a sloped tile gives the
  // same standing-Z the renderer drew.
  if (considerLand) {
    const lflags = landInfo(land.tileId).flags;
    // Water tiles are flagged Wet — block walking onto them on foot.
    // Acceptance for swimming creatures / boats is not yet wired; ServUO
    // gates on `Mobile.CanSwim` / `IsBodyBoat` which we treat as `false`
    // for every mover until we have a proper boat/swim API.
    const landBlocks = (lflags & FLAG_IMPASSABLE) !== 0
                    || (lflags & FLAG_WET) !== 0;
    if (!landBlocks && stepTop >= landZ && z - landCenter <= MAX_DROP) {
      const ourZ = landCenter;
      const testTop = Math.max(checkTop, ourZ + PERSON_HEIGHT);
      if (isOk(facet, nx, ny, ourZ, testTop)) {
        const dist = Math.abs(ourZ - z);
        if (bestZ === null || dist < bestDist || (dist === bestDist && ourZ < bestZ)) {
          bestDist = dist;
          bestZ = ourZ;
        }
      }
    }
  }

  return bestZ;
}

/**
 * Snap a (possibly-stale) z to the nearest legal standing surface at (x, y).
 *
 * Used when bringing a mobile into the world: the character list / spawn
 * tables hardcode a z that may be slightly off from the actual walkable
 * surface (e.g., the floor at Sweet Dreams Inn). Without this snap, the
 * character lands "between floors" — the renderer draws them at the wrong
 * elevation AND every move is rejected because no candidate surface is
 * within climb budget.
 *
 * Strategy: collect all surface candidates at (x,y), filter by clearance
 * (using the candidate's OWN z as `ourZ`), and return the one whose z is
 * closest to the requested z. We deliberately do NOT gate by climb budget
 * here — this is a teleport, not a step.
 */
export function findStandingZ(facet, x, y, requestedZ) {
  const land = landProvider.landAt(facet, x, y);
  const candidates = [];
  if (land) {
    const flags = landInfo(land.tileId).flags;
    if ((flags & (FLAG_IMPASSABLE | FLAG_WET)) === 0) {
      candidates.push({ z: getAverageZ(facet, x, y)?.avg ?? land.z });
    }
  }
  for (const s of landProvider.staticsAt(facet, x, y)) {
    const info = staticInfo(s.tileId);
    // Same Surface-without-Impassable filter as resolveCardinalStep — don't
    // snap the spawn to the top of a railing/bed/decoration.
    const isWalkable = (info.flags & FLAG_SURFACE) !== 0
                    && (info.flags & FLAG_IMPASSABLE) === 0;
    const isDoor = (info.flags & FLAG_DOOR) !== 0;
    if (!isWalkable && !isDoor) continue;
    candidates.push({ z: s.z + calcHeight(info) });
  }
  if (_runtimeSurfaceAt) {
    for (const s of _runtimeSurfaceAt(facet, x, y)) {
      const height = Math.max(0, s.height | 0);
      candidates.push({ z: (s.z | 0) + (s.bridge ? (height >> 1) : height) });
    }
  }
  if (!candidates.length) return requestedZ;

  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!isOk(facet, x, y, c.z, c.z + PERSON_HEIGHT)) continue;
    const d = Math.abs(c.z - requestedZ);
    // Prefer surfaces at or above the requested z (you typically want to
    // stand ON a building's floor, not sink under it). Equal distance —
    // prefer the higher one.
    if (d < bestDist || (d === bestDist && c.z > best)) {
      best = c.z;
      bestDist = d;
    }
  }
  return best;
}

/** Backward-compatible spawn/login snap. Callers which need to distinguish a
 * blocked destination (Teleport and summons) use `findStandingZ`; legacy
 * login paths retain their permissive requested-z fallback. */
export function resolveStandingZ(facet, x, y, requestedZ) {
  return findStandingZ(facet, x, y, requestedZ) ?? requestedZ;
}

/**
 * Can the mobile step from (x, y, z) to (nx, ny)? Returns the z the
 * character ends up on, or null if no candidate surface is reachable.
 *
 * For diagonal moves we additionally enforce CUO's **no-corner-cutting**
 * rule (Pathfinder.cs `CheckDiagonal` + `MovementImpl.Check`): both
 * cardinal neighbours connecting source and destination must themselves
 * be walkable. This stops you from slipping diagonally between two walls
 * that would otherwise form a tight X corner.
 *
 * @param {number} facet
 * @param {number} x  current x
 * @param {number} y  current y
 * @param {number} z  current z
 * @param {number} nx target x
 * @param {number} ny target y
 */
export function resolveStep(facet, x, y, z, nx, ny) {
  const dx = nx - x;
  const dy = ny - y;
  if (dx !== 0 && dy !== 0) {
    const sideA = resolveCardinalStep(facet, x, y, z, x + dx, y);
    if (sideA == null) return null;
    const sideB = resolveCardinalStep(facet, x, y, z, x, y + dy);
    if (sideB == null) return null;
  }
  return resolveCardinalStep(facet, x, y, z, nx, ny);
}
