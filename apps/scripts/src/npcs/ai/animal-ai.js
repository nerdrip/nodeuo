// Animal AI — flee-when-threatened, wander-when-calm. Wild creatures
// without notoriety (rabbits, deer, sheep) and tameable cubs use this.
// ServUO equivalent: AnimalAI + simple WildAnimalAI shells.
//
// Distinction vs aggressive.js:
//   - never initiates combat
//   - flees from any mobile within `panicRange` (default 5)
//   - wanders idly within `range` of spawn home
//
// State persists between ticks: { home, lastWanderAt, fleeUntil, panicSrc }.

import { nearbyMobiles } from '../../_spatial.js';

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function findThreat(api, world, mob, range) {
  let best = null;
  let bestDist = range + 1;
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const other of candidates) {
    if (other === mob || other.map !== mob.map) continue;
    if ((other.hp ?? 0) <= 0 || other.ghost) continue;
    // Players or notoriety>=4 (criminal/enemy/murderer/aggressor) panic us.
    if (!other.client && (other.notoriety ?? 1) < 4) continue;
    const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
    if (d < bestDist) { best = other; bestDist = d; }
  }
  return best;
}

// AIScheduler.stepMobile intentionally separates a turn from a step (classic
// player movement semantics). An AI decision is already a complete movement
// intention, so finish the step immediately after a successful pure turn.
// Otherwise a random animal picks another direction on its next think and
// spends most of its life rotating/jumping in place.
function stepAnimal(api, mob, dir) {
  const x0 = mob.x | 0, y0 = mob.y | 0;
  if (!api.ai.stepMobile?.(mob, dir)) return false;
  if (mob.x !== x0 || mob.y !== y0) return true;
  return !!api.ai.stepMobile?.(mob, dir);
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai) return () => {};

  api.ai.registerBehavior({
    name: 'animal',
    initState() { return { home: null, nextStepAt: 0, fleeUntil: 0 }; },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const now = ctx.now;

      const cfg = api.monsters?.get?.(mob.kind) ?? {};
      const panicRange = cfg.panicRange ?? 5;
      const wanderRange = cfg.wanderRange ?? 4;

      // Bigger creatures fly away when hurt.
      const hpFrac = (mob.hp ?? 0) / Math.max(1, mob.hpMax ?? 1);
      if (hpFrac < 0.5) state.fleeUntil = Math.max(state.fleeUntil, now + 5000);

      const threat = findThreat(api, ctx.world, mob, panicRange);
      if (threat) state.fleeUntil = Math.max(state.fleeUntil, now + 4000);

      if (state.fleeUntil > now) {
        if (now >= state.nextStepAt) {
          state.nextStepAt = now + 350;
          const ref = threat ?? state.home;
          const dx = mob.x - ref.x;
          const dy = mob.y - ref.y;
          const dir = dirTowards(dx, dy);
          if (stepAnimal(api, mob, dir)) ctx.broadcastMove(mob);
        }
        return;
      }

      // Idle wander — drift back home if we strayed, otherwise random step.
      if (now < state.nextStepAt) return;
      state.nextStepAt = now + 1500;
      const homeDx = mob.x - state.home.x;
      const homeDy = mob.y - state.home.y;
      const farFromHome = Math.max(Math.abs(homeDx), Math.abs(homeDy)) > wanderRange;
      let dir;
      if (farFromHome) dir = dirTowards(state.home.x - mob.x, state.home.y - mob.y);
      else dir = (Math.random() * 8) | 0;
      if (stepAnimal(api, mob, dir)) ctx.broadcastMove(mob);
    },
  });

  return () => api.ai.unregisterBehavior('animal');
}
