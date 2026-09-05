// PathFollower — high-level NPC movement helper. ServUO
// `Movement/PathFollower.cs`.
//
// The pathfinder (`world/pathfind.js`) computes a list of tiles from
// start to goal; PathFollower owns the *consumption* of that list over
// time. It exposes:
//   • `start(mob, target)` — bind to a moving target. Recomputes path
//     when the target moves >2 tiles from the last cached goal.
//   • `tick(mob, dt)` — advance one step toward the next tile in the
//     cached path. Returns true if the mob reached the goal.
//   • `stop(mob)` — drop the cached path.
//
// State is per-mob:
//   mob._pathFollower = { goalSerial, lastGoalX, lastGoalY, path, idx,
//                         lastStepAt, stepDelayMs }

import { findPath } from './pathfind.js';
import { resolveStep } from './movement.js';
import { dispatchTileWalkEvents } from './item-scripts.js';

const DEFAULT_STEP_MS = 350;        // walking cadence — matches AI tick
const REPATH_THRESHOLD = 2;         // tiles target may drift before re-plan
const DELTAS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

export function start(world, mob, target, opts = {}) {
  if (!mob || !target) return false;
  if ((target.map ?? mob.map) !== mob.map) return false;
  const path = findPath({
    facet: mob.map,
    sx: mob.x | 0, sy: mob.y | 0, sz: mob.z | 0,
    gx: target.x | 0, gy: target.y | 0,
    maxNodes: opts.maxNodes ?? 800,
    goalRadius: opts.goalRadius ?? 1,
  });
  if (!path || path.length === 0) return false;
  mob._pathFollower = {
    goalSerial: target.serial >>> 0,
    lastGoalX: target.x | 0,
    lastGoalY: target.y | 0,
    path,
    idx: 0,
    lastStepAt: 0,
    stepDelayMs: opts.stepDelayMs ?? DEFAULT_STEP_MS,
  };
  return true;
}

/** Returns true when the mob has reached the goal (or the path lapsed). */
export function tick(world, mob, target, now = Date.now()) {
  const pf = mob?._pathFollower;
  if (!pf) return false;
  // Target moved enough → re-plan.
  if (target && (Math.abs((target.x | 0) - pf.lastGoalX) > REPATH_THRESHOLD ||
                 Math.abs((target.y | 0) - pf.lastGoalY) > REPATH_THRESHOLD)) {
    return start(world, mob, target, {
      stepDelayMs: pf.stepDelayMs, maxNodes: 800,
    });
  }
  if (pf.idx >= pf.path.length) { stop(mob); return true; }
  if (now - pf.lastStepAt < pf.stepDelayMs) return false;
  const next = pf.path[pf.idx];
  if (!Number.isInteger(next) || next < 0 || next > 7) { stop(mob); return true; }
  const before = { x: mob.x | 0, y: mob.y | 0, z: mob.z | 0, map: mob.map ?? 1 };
  const [dx, dy] = DELTAS[next];
  const nx = before.x + dx, ny = before.y + dy;
  // `findPath` returns direction bytes, not tile objects. Route the step
  // through the canonical movement validator so doors/traps/sector indexes
  // stay consistent.
  const nz = resolveStep(mob.map, before.x, before.y, before.z, nx, ny);
  if (nz === null) {
    return target ? start(world, mob, target, { stepDelayMs: pf.stepDelayMs, maxNodes: 800 }) : false;
  }
  mob.x = nx; mob.y = ny; mob.z = nz; mob.direction = next;
  world?.sectors?.moveMobile?.(mob);
  dispatchTileWalkEvents(world, mob, before, { x: nx, y: ny, z: nz, map: mob.map });
  pf.idx++;
  pf.lastStepAt = now;
  return false;
}

export function stop(mob) {
  if (mob) delete mob._pathFollower;
}

/** Is the mob currently chasing? */
export function isFollowing(mob) {
  return Boolean(mob?._pathFollower);
}
