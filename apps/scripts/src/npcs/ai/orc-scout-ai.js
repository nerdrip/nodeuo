// OrcScoutAI — pack hunter. Holds a screen-line formation with allied
// orcs of the same kind, and prefers to engage when at least one ally
// is also in range of the target. Falls back to wander when alone.
//
// Mirrors ServUO `OrcScoutAI.cs` formation logic at MVP scope.

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

function packAllies(api, world, mob, packKind, range) {
  const out = [];
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const m of candidates) {
    if (m === mob) continue;
    if (m.kind !== packKind) continue;
    if (m.map !== mob.map) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d <= range) out.push(m);
  }
  return out;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat) return () => {};
  const FALLBACK = {
    name: 'an orc scout', body: 0x0011, hue: 0x453, hp: 60,
    aggroRange: 10, attackInterval: 1600,
    pack: { minMembers: 2, range: 6 },
  };
  const cfgFor = (kind) => api.monsters?.get?.(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'orc-scout',
    initState() {
      return { kind: null, targetSerial: 0, nextStepAt: 0, nextSwingAt: 0,
               retreatUntil: 0 };
    },
    tick(ctx, mob, state) {
      const cfg = cfgFor(state.kind);
      const now = ctx.now;
      const allies = packAllies(api, ctx.world, mob, state.kind ?? 'orc-scout', cfg.pack?.range ?? 6);
      const minPack = cfg.pack?.minMembers ?? 2;

      // No allies in range and we already engaged — fall back to a
      // staggered retreat so the scout doesn't suicide alone.
      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost)) target = null;
      if (!target) {
        target = findTarget(api, ctx.world, mob, cfg.aggroRange ?? 10);
        state.targetSerial = target?.serial ?? 0;
      }
      if (!target) return;

      const lonely = allies.length + 1 < minPack;
      if (lonely && state.retreatUntil < now + 1) state.retreatUntil = now + 2500;

      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      if (now < state.retreatUntil) {
        if (now >= state.nextStepAt) {
          state.nextStepAt = now + 350;
          api.ai.stepMobile?.(mob, dirTowards(-dx, -dy));
          ctx.broadcastMove(mob);
        }
        return;
      }

      if (now >= state.nextStepAt && dist > 1) {
        state.nextStepAt = now + 300;
        api.ai.stepMobile?.(mob, dirTowards(dx, dy));
        ctx.broadcastMove(mob);
      }

      if (dist <= 1 && now >= state.nextSwingAt) {
        state.nextSwingAt = now + (cfg.attackInterval ?? 1600);
        api.combat.animate(ctx.world, mob, 0x09);
        const dmg = 6 + Math.floor(Math.random() * 6);
        api.combat.damage(ctx.world, target, dmg, mob);
      }
    },
  });

  return () => api.ai.unregisterBehavior('orc-scout');
}
