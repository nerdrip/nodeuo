// Region OnEnter dispatch — fires content callbacks when a player crosses
// from one named region into another. ServUO `Region.OnEnter` is the canon
// hook scripts use to spawn town guards, swap music, gate teleports, etc.
//
// Our regions live in `apps/server/src/regions.js` (flag-driven). This
// module sits on top: a registry of `{ regionName, onEnter, onLeave }`
// callbacks, and an `update(world, mob)` call that diffs the mob's
// previous region against its current one and fires the right hook.
//
// Typical use:
//   import { onEnterRegion } from './systems/region-onenter.js';
//   onEnterRegion('Britain Bank', (mob, ctx) => {
//     // greet the player, deny PvP, etc.
//   });

const _onEnterMap = new Map();
const _onLeaveMap = new Map();
// Wildcard listeners — fire for EVERY region transition, named or not.
// Used by `apps/scripts/src/spawns/town-guards.js` to react when ANY
// notoriety-5/6 mob walks into ANY guarded city without registering a
// per-city callback.
const _onAnyEnterCallbacks = new Set();

export function onEnterRegion(name, fn) { _onEnterMap.set(name, fn); }
export function onLeaveRegion(name, fn) { _onLeaveMap.set(name, fn); }
export function onAnyEnter(fn) {
  _onAnyEnterCallbacks.add(fn);
  return () => _onAnyEnterCallbacks.delete(fn);
}

/**
 * Update the mob's region cache and fire callbacks if the region
 * changed. Caller passes the resolver function (so this module stays
 * decoupled from regions.js: we don't import it at module-load time).
 *
 * @param {{ x:number, y:number, map:number }} mob
 * @param {(mob:any) => string|null} resolveRegion  returns the active region name (or null)
 * @param {object} ctx  forwarded to the callbacks; at minimum `world`
 */
export function updateRegion(mob, resolveRegion, ctx = {}) {
  const next = resolveRegion(mob) ?? null;
  const prev = mob._region ?? null;
  if (next === prev) return;
  mob._region = next;
  if (prev && _onLeaveMap.has(prev)) {
    try { _onLeaveMap.get(prev)(mob, { ...ctx, prev, next }); }
    catch (e) { console.error(`[region] onLeave ${prev}:`, e); }
  }
  if (next && _onEnterMap.has(next)) {
    try { _onEnterMap.get(next)(mob, { ...ctx, prev, next }); }
    catch (e) { console.error(`[region] onEnter ${next}:`, e); }
  }
  // Wildcard fan-out — fires for every transition (including the
  // null→named "first ever enter" pulse and named→null "logged out
  // here" pulse). Town-guard auto-call hangs off this.
  if (_onAnyEnterCallbacks.size > 0) {
    for (const cb of _onAnyEnterCallbacks) {
      try { cb(mob, { ...ctx, prev, next }); }
      catch (e) { console.error('[region] onAnyEnter:', e); }
    }
  }
}

/** Test helper — drop all registrations. */
export function _clearRegionHooks() {
  _onEnterMap.clear();
  _onLeaveMap.clear();
  _onAnyEnterCallbacks.clear();
}
