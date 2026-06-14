// BerserkAI — never flees, hits harder as HP drops. Mirrors ServUO
// `BerserkAI.cs` ("Lord Oaks" lich-style enrage).
//
// Damage scaling:
//   HP > 75% → 1.0×
//   HP 25-75% → 1.25×
//   HP < 25% → 1.5× + +1 swing speed (stacks with paragon if applicable)

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
    name: 'a berserker', body: 0x0011, hue: 0x40, hp: 200, hpMax: 200,
    aggroRange: 12, attackInterval: 1400,
  };
  const cfgFor = (kind) => api.monsters?.get?.(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'berserk',
    initState() { return { kind: null, targetSerial: 0, nextStepAt: 0, nextSwingAt: 0 }; },
    tick(ctx, mob, state) {
      const cfg = cfgFor(state.kind);
      const now = ctx.now;
      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost)) target = null;
      if (!target) {
        target = findTarget(api, ctx.world, mob, cfg.aggroRange ?? 12);
        state.targetSerial = target?.serial ?? 0;
      }
      if (!target) return;
      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      // HP-driven aggression multiplier.
      const hpFrac = (mob.hp ?? 0) / Math.max(1, mob.hpMax ?? 1);
      const dmgMul   = hpFrac < 0.25 ? 1.5 : hpFrac < 0.75 ? 1.25 : 1.0;
      const swingMul = hpFrac < 0.25 ? 0.7 : 1.0;

      // Always charge — never flee.
      if (now >= state.nextStepAt && dist > 1) {
        state.nextStepAt = now + 280;
        api.ai.stepMobile?.(mob, dirTowards(dx, dy));
        ctx.broadcastMove(mob);
      }

      if (dist <= 1 && now >= state.nextSwingAt) {
        state.nextSwingAt = now + Math.max(400, (cfg.attackInterval ?? 1400) * swingMul);
        api.combat.animate(ctx.world, mob, 0x09);
        const base = (cfg.dmgMin ?? 8) + Math.floor(Math.random() * Math.max(1, (cfg.dmgMax ?? 16) - (cfg.dmgMin ?? 8)));
        api.combat.damage(ctx.world, target, Math.round(base * dmgMul), mob);
      }
    },
  });

  return () => api.ai.unregisterBehavior('berserk');
}
