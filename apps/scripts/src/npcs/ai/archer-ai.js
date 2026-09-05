// ArcherAI — kite at range, fire ranged attacks. Port of ServUO
// `Mobiles/AI/ArcherAI.cs`: when the target is in melee range, step
// back; when within firing range, swing the bow; otherwise close.
//
// Config (per-mob via monsters.json `archery`):
//   { range: [4, 8],            // ideal min/max distance from target
//     swingMs: 1800,             // arrow cooldown
//     damage: [6, 12],           // arrow damage range
//     graphicId: 0x1B FE,        // arrow projectile graphic (fletcher arrow)
//     soundId: 0x223 }           // bow release sfx
//
// State: { home, targetSerial, nextSwingAt, nextStepAt, kind }.

import { nearbyMobiles, sendToClientsNear } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function findNearestPlayer(api, world, mob, range) {
  let best = null, bestDist = range + 1;
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const other of candidates) {
    if (!other.client || other.map !== mob.map) continue;
    if (other.ghost || (other.hp ?? 0) <= 0) continue;
    const dx = Math.abs(other.x - mob.x);
    const dy = Math.abs(other.y - mob.y);
    const d = Math.max(dx, dy);
    if (d < bestDist) { best = other; bestDist = d; }
  }
  return best;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log?.('npc/archer-ai: missing api deps; skipping');
    return () => {};
  }
  const FALLBACK = {
    name: 'an archer', body: 0x0190, hue: 0, hp: 75,
    aggroRange: 12, attackInterval: 1500,
    archery: {
      range: [4, 9], swingMs: 1800, damage: [6, 14],
      graphicId: 0x1BFE, soundId: 0x223,
    },
  };
  const cfgFor = (kind) => api.monsters.get(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'archer',
    initState() {
      return { kind: null, targetSerial: 0, nextSwingAt: 0, nextStepAt: 0, home: null };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const cfg = cfgFor(state.kind);
      const now = ctx.now;
      const archery = cfg.archery ?? FALLBACK.archery;
      const [minR, maxR] = archery.range ?? [4, 9];

      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost || target.map !== mob.map)) target = null;

      if (!target) {
        target = findNearestPlayer(api, ctx.world, mob, cfg.aggroRange ?? 12);
        if (target) state.targetSerial = target.serial;
      }

      if (!target) {
        // Idle wander toward home.
        if (now < state.nextStepAt) return;
        state.nextStepAt = now + 1800;
        const homeDx = mob.x - state.home.x, homeDy = mob.y - state.home.y;
        if (Math.max(Math.abs(homeDx), Math.abs(homeDy)) > 5) {
          const dir = dirTowards(state.home.x - mob.x, state.home.y - mob.y);
          if (api.ai.stepMobile?.(mob, dir)) ctx.broadcastMove(mob);
        }
        return;
      }

      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      // Kite logic: too close → step back; in range → fire; too far → close.
      if (now >= state.nextStepAt) {
        state.nextStepAt = now + 400;
        let dir = -1;
        if (dist < minR) dir = dirTowards(-dx, -dy);          // back away
        else if (dist > maxR) dir = dirTowards(dx, dy);       // close in
        if (dir >= 0 && api.ai.stepMobile?.(mob, dir)) ctx.broadcastMove(mob);
      }

      if (dist >= minR && dist <= maxR && now >= state.nextSwingAt) {
        state.nextSwingAt = now + (archery.swingMs ?? 1800);
        // Visual + audio: animate the archer + send a graphical effect of
        // the arrow flying. Damage is applied directly through combat.
        api.combat.animate?.(ctx.world, mob, 0x09);            // bow shoot frame
        const fxPkt = api.protocol.graphicalEffect?.({
          kind: api.protocol.EffectKind?.Moving ?? 0,
          from: mob.serial, to: target.serial,
          itemId: archery.graphicId ?? 0x1BFE,
          fromX: mob.x, fromY: mob.y, fromZ: mob.z,
          toX: target.x, toY: target.y, toZ: target.z,
          fixedDirection: false, explodes: false, hue: 0, blendMode: 0,
          speed: 5, duration: 0,
        });
        if (fxPkt) {
          sendToClientsNear(api, mob, fxPkt);
        }
        if (archery.soundId) api.combat.playSoundNear?.(ctx.world, mob, archery.soundId);
        const [lo, hi] = archery.damage ?? [6, 12];
        const dmg = lo + Math.floor(Math.random() * (hi - lo + 1));
        // Use the same skill/attribute/weapon hit formula as player combat.
        // This keeps custom archer templates and debuffs meaningful instead
        // of giving every ranged NPC an unconditional flat 75% roll.
        const chance = api.combat.hitChance?.(mob, target) ?? 0.75;
        if (Math.random() < chance && api.combat.damage) {
          api.combat.damage(ctx.world, target, dmg, { attacker: mob, type: 'physical' });
        }
      }
    },
  });

  return () => api.ai.unregisterBehavior('archer');
}
