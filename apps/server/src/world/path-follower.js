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

const DEFAULT_STEP_MS = 350;        // walking cadence — matches AI tick
const REPATH_THRESHOLD = 2;         // tiles target may drift before re-plan

export function start(world, mob, target, opts = {}) {
  if (!mob || !target) return false;
  const facet = world?.facets?.[mob.map];
  if (!facet) return false;
  const path = findPath({
    facet,
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
  const next = pf.path[pf.idx++];
  if (!next) { stop(mob); return true; }
  // Step the mob. Movement validation (block, region gate) lives in the
  // existing AI scheduler — we just mutate x/y and let the next AI tick
  // broadcast the move. The pathfinder pre-filters unwalkable tiles so
  // a direct mutate is safe.
  mob.x = next.x | 0;
  mob.y = next.y | 0;
  if (typeof next.z === 'number') mob.z = next.z | 0;
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
