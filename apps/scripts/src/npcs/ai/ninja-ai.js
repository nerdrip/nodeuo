// NinjaAI — stealth + backstab + smoke-bomb retreat. ServUO `NinjaAI.cs`.
//
// Behavior cycle:
//   1. Hidden by default; approaches target while invisible.
//   2. On adjacency, reveal + 2x melee swing (backstab burst).
//   3. After burst, smoke-bomb (re-hide) + 2-tile retreat.
//   4. Cooldown 4s before next burst.

import { nearbyMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

function dirTowards(dx, dy) {
  const a = Math.atan2(dy, dx);
  return (Math.round(a / (Math.PI / 4)) + 10) & 7;
}

function findTarget(api, world, mob, range) {
  let best = null, bestD = range + 1;
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const m of candidates) {
    if (!m.client || m.map !== mob.map || m.ghost) continue;
    if ((m.hp ?? 0) <= 0) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d < bestD) { best = m; bestD = d; }
  }
  return best;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat) return () => {};
  const FALLBACK = {
    name: 'a ninja', body: 0x0190, hue: 0x21, hp: 80, hpMax: 80,
    aggroRange: 10, attackInterval: 800,
  };
  const cfgFor = (kind) => api.monsters?.get?.(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'ninja',
    initState() {
      return {
        kind: null, targetSerial: 0, nextStepAt: 0, nextBurstAt: 0,
        burstSwingsLeft: 0, retreatUntil: 0,
      };
    },
    tick(ctx, mob, state) {
      const cfg = cfgFor(state.kind);
      const now = ctx.now;
      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost)) target = null;
      if (!target) {
        target = findTarget(api, ctx.world, mob, cfg.aggroRange ?? 10);
        state.targetSerial = target?.serial ?? 0;
        // Default: hidden when not in burst.
        mob.hidden = true;
      }
      if (!target) return;

      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      // Retreat phase — backpedal 2 tiles after a burst.
      if (now < state.retreatUntil) {
        if (now >= state.nextStepAt) {
          state.nextStepAt = now + 250;
          api.ai.stepMobile?.(mob, dirTowards(-dx, -dy));
          ctx.broadcastMove(mob);
        }
        return;
      }

      // Burst phase — reveal + chained swings.
      if (state.burstSwingsLeft > 0) {
        if (dist <= 1) {
          mob.hidden = false; // revealed during burst
          state.burstSwingsLeft--;
          api.combat.animate(ctx.world, mob, 0x09);
          const base = (cfg.dmgMin ?? 6) + Math.floor(Math.random() * 6);
          // Backstab: +50% damage on first hit if target unaware.
          const mul = state.burstSwingsLeft === 1 ? 1.5 : 1.0;
          api.combat.damage(ctx.world, target, Math.round(base * mul), mob);
          if (state.burstSwingsLeft === 0) {
            // Smoke bomb — re-hide, retreat for 1.5s, then 4s cooldown.
            mob.hidden = true;
            state.retreatUntil = now + 1500;
            state.nextBurstAt  = now + 4000;
          }
        }
        return;
      }

      // Approach (still hidden).
      mob.hidden = true;
      if (now >= state.nextStepAt && dist > 1) {
        state.nextStepAt = now + 300;
        api.ai.stepMobile?.(mob, dirTowards(dx, dy));
        ctx.broadcastMove(mob);
      }
      // Initiate burst on adjacency.
      if (dist <= 1 && now >= state.nextBurstAt) {
        state.burstSwingsLeft = 2;
      }
    },
  });

  return () => api.ai.unregisterBehavior('ninja');
}
