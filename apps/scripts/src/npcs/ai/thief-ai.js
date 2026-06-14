// ThiefAI — NPC pickpocket / poisoner. Mirrors ServUO `ThiefAI.cs`.
//
// Behavior:
//   - Approach silently (favours Hiding skill if available).
//   - When adjacent to a player, attempt to "snoop" their backpack
//     (we surface the gesture as a hidden flag so detection scripts
//     can react).
//   - On melee opportunity, swing a poisoned blade — applies the
//     `poison` status effect via api.statusEffects on hit.
//   - Flee on low HP using the same A* path as aggressive.

import { nearbyMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

function dirTowards(dx, dy) {
  const a = Math.atan2(dy, dx);
  return (Math.round(a / (Math.PI / 4)) + 10) & 7;
}

function findVictim(api, world, mob, range) {
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
    name: 'a thief', body: 0x0190, hue: 0, hp: 50, mana: 30, manaMax: 30,
    aggroRange: 8, attackInterval: 1500,
    poison: { name: 'lesser', durationMs: 12_000 },
  };
  const cfgFor = (kind) => api.monsters?.get?.(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'thief',
    initState() {
      return { kind: null, targetSerial: 0, nextStepAt: 0, nextSwingAt: 0, home: null };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const cfg = cfgFor(state.kind);
      const now = ctx.now;
      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost)) target = null;
      if (!target) {
        target = findVictim(api, ctx.world, mob, cfg.aggroRange ?? 8);
        state.targetSerial = target?.serial ?? 0;
      }
      if (!target) return;

      // Sneak — mark hidden until adjacent so detection scripts can call us out.
      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      mob.hidden = dist > 1;

      if (now >= state.nextStepAt && dist > 1) {
        state.nextStepAt = now + 350;
        api.ai.stepMobile?.(mob, dirTowards(dx, dy));
        ctx.broadcastMove(mob);
      }

      if (dist <= 1 && now >= state.nextSwingAt) {
        state.nextSwingAt = now + (cfg.attackInterval ?? 1500);
        api.combat.animate(ctx.world, mob, 0x09);
        const dmg = 4 + Math.floor(Math.random() * 6);
        api.combat.damage(ctx.world, target, dmg, mob);
        // Apply poison via status effects (if available).
        if (api.statusEffects && cfg.poison) {
          api.statusEffects.apply(target, {
            name: 'poison',
            durationMs: cfg.poison.durationMs ?? 10_000,
            tickIntervalMs: 2000,
            data: { tier: cfg.poison.name ?? 'lesser' },
            tick(victim, w) {
              const t = (cfg.poison.dmg ?? 3) + Math.floor(Math.random() * 3);
              api.combat.damage(w, victim, t, mob);
            },
          });
        }
      }
    },
  });

  return () => api.ai.unregisterBehavior('thief');
}
