// Permanent town-guard AI for civic NPCs placed by createworld.
// Event-driven guard calls still live in spawns/town-guards.js; this behavior
// keeps the visible guards themselves active and able to intercept nearby
// criminals instead of leaving the data-driven `behavior: "guard"` inert.

import { mobileBySerial } from '../../_entities.js';
import { allMobiles, nearbyMobiles } from '../../_spatial.js';

const NOTICE_RANGE = 12;
const ATTACK_MS = 750;

function isCriminal(mobile, now) {
  return !!mobile?.client && !mobile.ghost && (mobile.hp ?? 0) > 0
    && ((mobile.criminalUntil ?? 0) > now
      || (mobile.kills | 0) >= 5
      || mobile.murderer === true
      || (mobile.notoriety | 0) === 6);
}

function distance(a, b) {
  return Math.max(Math.abs((a.x | 0) - (b.x | 0)), Math.abs((a.y | 0) - (b.y | 0)));
}

function directionTowards(from, to) {
  const angle = Math.atan2((to.y | 0) - (from.y | 0), (to.x | 0) - (from.x | 0));
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function nearestCriminal(api, guard, now) {
  let best = null;
  let bestDistance = NOTICE_RANGE + 1;
  for (const mobile of nearbyMobiles(api, guard, guard, NOTICE_RANGE)) {
    if (mobile.map !== guard.map || !isCriminal(mobile, now)) continue;
    const candidateDistance = distance(guard, mobile);
    if (candidateDistance < bestDistance) {
      best = mobile;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

export default function register(api) {
  if (!api.ai || !api.combat) return () => {};

  api.ai.registerBehavior({
    name: 'guard',
    initState() {
      return { targetSerial: 0, nextAttackAt: 0, nextStepAt: 0, home: null };
    },
    tick(ctx, guard, state) {
      state.home ??= { x: guard.x, y: guard.y };
      guard.invulnerable = true;
      guard.isGuard = true;

      let target = state.targetSerial
        ? mobileBySerial({ world: ctx.world }, state.targetSerial)
        : null;
      if (!isCriminal(target, ctx.now) || target.map !== guard.map || distance(guard, target) > NOTICE_RANGE) {
        target = nearestCriminal(api, guard, ctx.now);
        state.targetSerial = target?.serial ?? 0;
        if (target) ctx.broadcastSpeech?.(guard, 'Halt, criminal!', 0x0026);
      }

      if (!target) {
        if (distance(guard, state.home) > 2 && ctx.now >= state.nextStepAt) {
          state.nextStepAt = ctx.now + 400;
          if (api.ai.stepMobile?.(guard, directionTowards(guard, state.home))) {
            ctx.broadcastMove?.(guard);
          }
        }
        return;
      }

      if (distance(guard, target) <= 1) {
        if (ctx.now < state.nextAttackAt) return;
        state.nextAttackAt = ctx.now + ATTACK_MS;
        api.combat.animate?.(ctx.world, guard, 0x09);
        api.combat.damage?.(ctx.world, target, Math.max(1, target.hp | 0), {
          attacker: guard,
          type: 'physical',
        });
        return;
      }

      if (ctx.now >= state.nextStepAt) {
        state.nextStepAt = ctx.now + 250;
        if (api.ai.stepMobile?.(guard, directionTowards(guard, target))) {
          ctx.broadcastMove?.(guard);
        }
      }
    },
  });

  // Vendor/civic restoration can run before this module is registered.
  // Reconcile saved guards once the implementation becomes available.
  for (const mobile of allMobiles(api)) {
    if (mobile.aiBehavior !== 'guard' && !mobile.isGuard) continue;
    try {
      api.ai.attach(mobile, 'guard');
      mobile.aiBehavior = 'guard';
    } catch { /* a malformed persisted row remains safely detached */ }
  }

  return () => api.ai.unregisterBehavior('guard');
}
