// PredatorAI — wolves, panthers, dire wolves, pack-hunting beasts.
// Pure-melee aggressive AI with two ServUO-PredatorAI tweaks:
//   1. "Pack call" — when a predator engages, every same-kind predator
//      within `packRange` switches to the same target. Mirrors ServUO's
//      `BaseCreature.OnDamage` propagation through PackInstinctType.
//   2. Prey selection — prefers low-HP mobiles within sight (wolves
//      cull the weak). HP-fraction is the tiebreaker over distance.
//
// Config (per-mob via monsters.json `predator`):
//   { packRange: 8, attackInterval: 1500, damage: [4, 10] }
//
// State: { home, targetSerial, nextSwingAt, nextStepAt, kind }.

import { nearbyMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function findPrey(api, world, mob, range) {
  let best = null, bestScore = Infinity;
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const other of candidates) {
    if (!other.client && (other.notoriety ?? 1) < 4) continue;     // ignore peaceful NPCs
    if (other === mob || other.map !== mob.map) continue;
    if (other.ghost || (other.hp ?? 0) <= 0) continue;
    const dx = Math.abs(other.x - mob.x);
    const dy = Math.abs(other.y - mob.y);
    const d = Math.max(dx, dy);
    if (d > range) continue;
    // Score = distance + 10 * hpFraction (wolves prefer wounded).
    const hpFrac = (other.hp ?? 1) / Math.max(1, other.hpMax ?? 1);
    const score = d + 10 * hpFrac;
    if (score < bestScore) { best = other; bestScore = score; }
  }
  return best;
}

function callPack(api, world, leader, target, kind, packRange) {
  const candidates = nearbyMobiles(api, leader, leader, packRange);
  for (const other of candidates) {
    if (other === leader || other.client || other.map !== leader.map) continue;
    if (other.kind !== kind) continue;
    const d = Math.max(Math.abs(other.x - leader.x), Math.abs(other.y - leader.y));
    if (d > packRange) continue;
    other._aiState ??= {};
    if (other._aiState.targetSerial !== target.serial) {
      other._aiState.targetSerial = target.serial;
    }
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat || !api.monsters) {
    api.log?.('npc/predator-ai: missing api deps; skipping');
    return () => {};
  }
  const FALLBACK = {
    name: 'a wolf', body: 0xE1, hue: 0, hp: 50,
    aggroRange: 10, attackInterval: 1500,
    predator: { packRange: 8, damage: [4, 10] },
  };
  const cfgFor = (kind) => api.monsters.get(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'predator',
    initState() {
      return { kind: null, targetSerial: 0, nextSwingAt: 0, nextStepAt: 0, home: null };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      // Hot-loop the pack-mate sync — animal-ai.js sets this directly.
      if (mob._aiState?.targetSerial && !state.targetSerial) {
        state.targetSerial = mob._aiState.targetSerial;
      }
      const cfg = cfgFor(state.kind);
      const pred = cfg.predator ?? FALLBACK.predator;
      const now = ctx.now;

      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost || target.map !== mob.map)) target = null;

      if (!target) {
        target = findPrey(api, ctx.world, mob, cfg.aggroRange ?? 10);
        if (target) {
          state.targetSerial = target.serial;
          callPack(api, ctx.world, mob, target, state.kind, pred.packRange ?? 8);
        }
      }

      if (!target) {
        if (now < state.nextStepAt) return;
        state.nextStepAt = now + 1600;
        const homeDx = mob.x - state.home.x, homeDy = mob.y - state.home.y;
        if (Math.max(Math.abs(homeDx), Math.abs(homeDy)) > 5) {
          const dir = dirTowards(state.home.x - mob.x, state.home.y - mob.y);
          if (api.ai.stepMobile?.(mob, dir)) ctx.broadcastMove(mob);
        }
        return;
      }

      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      // Approach to melee.
      if (dist > 1 && now >= state.nextStepAt) {
        state.nextStepAt = now + 350;
        const dir = dirTowards(dx, dy);
        if (api.ai.stepMobile?.(mob, dir)) ctx.broadcastMove(mob);
      }

      if (dist <= 1 && now >= state.nextSwingAt) {
        state.nextSwingAt = now + (cfg.attackInterval ?? 1500);
        api.combat.animate?.(ctx.world, mob, 0x05);   // bite frame
        const [lo, hi] = pred.damage ?? [4, 10];
        const dmg = lo + Math.floor(Math.random() * (hi - lo + 1));
        if (api.combat.damage) {
          api.combat.damage(ctx.world, target, dmg, { attacker: mob, type: 'physical' });
        }
      }
    },
  });

  return () => api.ai.unregisterBehavior('predator');
}
