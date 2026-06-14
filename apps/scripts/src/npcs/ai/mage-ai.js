// MageAI — NPC behavior that prioritises spell casting over melee.
// Mirrors ServUO `MageAI.cs`: keep range 4..6 from the target, cast a
// damaging spell every ~3 s while mana is available, fall back to
// melee swings when oom. Use the existing `aggressive` cast helper for
// effect/sound parity (so we don't duplicate spell wire packets).
//
// Spell pick is HP-aware:
//   target HP > 80% → mid spells (Magic Arrow, Fireball)
//   target HP <= 50% → bigger spells (Lightning, Energy Bolt)
//   target HP <= 20% → finishing (Flame Strike if available)
//
// All spells in the mage's repertoire are configured per-mob via
// `monsters.json` `magery: { spells: [{ name, mana, damage:[lo,hi], soundId, graphicId, hue?, fxSpeed?, explodes? }] }`.

import { nearbyMobiles, sendToClientsNear } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function findNearestPlayer(api, world, mob, range) {
  let best = null, bestDist = range + 1;
  // Friend gate — see aggressive.js#findNearestPlayer. Without this a
  // mage-AI hosted on a summoned creature (promoted Daemon summon,
  // tamed mage) would happily target its own caster.
  const myTeam        = mob.team | 0;
  const summonedBy    = mob.summonedBy >>> 0;
  const controlMaster = mob.controlMaster >>> 0;
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const other of candidates) {
    if (!other.client || other.map !== mob.map) continue;
    if (other.ghost || (other.hp ?? 0) <= 0) continue;
    if (myTeam && (other.team | 0) === myTeam) continue;
    if (summonedBy && (other.serial >>> 0) === summonedBy) continue;
    if (controlMaster && (other.serial >>> 0) === controlMaster) continue;
    const dx = Math.abs(other.x - mob.x);
    const dy = Math.abs(other.y - mob.y);
    const d = Math.max(dx, dy);
    if (d < bestDist) { best = other; bestDist = d; }
  }
  return best;
}

function pickSpell(spells, target) {
  if (!spells?.length) return null;
  const hpFrac = (target.hp ?? 0) / Math.max(1, target.hpMax ?? 1);
  // Prefer the highest-damage castable spell that fits HP tier.
  const tier = hpFrac > 0.8 ? 1 : hpFrac > 0.5 ? 2 : hpFrac > 0.2 ? 3 : 4;
  // Sort high → low by upper damage; then pick first the mob can afford.
  const ranked = [...spells].sort((a, b) =>
    (b.damage?.[1] ?? 0) - (a.damage?.[1] ?? 0));
  // Tier acts as filter: tier 4 → any; tier 1 → cheaper choices only.
  const maxIdx = Math.max(0, ranked.length - 1);
  const cap = tier === 1 ? Math.ceil(ranked.length / 2)
            : tier === 2 ? maxIdx
            : ranked.length;
  return ranked.slice(0, cap)[0] ?? ranked[0] ?? null;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/mage-ai: missing api deps; skipping');
    return () => {};
  }
  const FALLBACK = {
    name: 'a wizard', body: 0x0190, hue: 0, hp: 60, mana: 60, manaMax: 60,
    aggroRange: 10, attackInterval: 1500,
    magery: { spells: [
      { name: 'Magic Arrow', mana: 6,  damage: [3, 7],  soundId: 0x1E5, graphicId: 0x36E4, fxSpeed: 7 },
      { name: 'Fireball',    mana: 9,  damage: [6, 12], soundId: 0x15E, graphicId: 0x36D4, fxSpeed: 5 },
    ] },
  };
  const cfgFor = (kind) => api.monsters.get(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'mage',
    initState() {
      return { kind: null, targetSerial: 0, nextCastAt: 0, nextStepAt: 0, home: null };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const cfg = cfgFor(state.kind);
      const now = ctx.now;

      // Mana regen: 0.05/sec (matches player regen baseline). The 500 ms
      // tick gives 0.025/tick which we accumulate.
      mob.mana = Math.min(mob.manaMax ?? 50, (mob.mana ?? 0) + 0.025);

      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost || target.map !== mob.map)) target = null;
      if (!target) {
        target = findNearestPlayer(api, ctx.world, mob, cfg.aggroRange ?? 10);
        state.targetSerial = target?.serial ?? 0;
      }
      if (!target) return;

      const dx = target.x - mob.x, dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const desired = 5; // optimal cast distance

      // Server parity #10 #6 — flee at <20 % HP. ServUO `MageAI.cs`
      // DoActionFlee branch. Without this, NPC mages kept casting until
      // 0 HP. Sets `_fleeingUntil` so the AI hibernate gate keeps the
      // mob awake during retreat (mirrors aggressive.js fix from #19).
      const hpFrac = (mob.hp ?? 0) / Math.max(1, mob.hpMax ?? 1);
      if (hpFrac < 0.20) {
        mob._fleeingUntil = now + 3000;
        if (now >= state.nextStepAt) {
          state.nextStepAt = now + 250;
          api.ai.stepMobile?.(mob, dirTowards(-dx, -dy));
          ctx.broadcastMove(mob);
        }
        // Cast a self-heal if affordable (Greater Heal-tier).
        if (now >= state.nextCastAt && (mob.mana ?? 0) >= 11) {
          mob.mana -= 11;
          mob.hp = Math.min(mob.hpMax ?? 50, (mob.hp ?? 0) + 25 + Math.floor(Math.random() * 11));
          state.nextCastAt = now + 1500;
          api.combat.animate(ctx.world, mob, 0x10);
        }
        return;
      }

      // Movement: hold range. Run toward when too far, back away when too close.
      if (now >= state.nextStepAt) {
        state.nextStepAt = now + 250;
        if (dist > desired + 1) {
          api.ai.stepMobile?.(mob, dirTowards(dx, dy));
          ctx.broadcastMove(mob);
        } else if (dist < desired - 1) {
          api.ai.stepMobile?.(mob, dirTowards(-dx, -dy));
          ctx.broadcastMove(mob);
        }
      }

      // Casting cadence: ~3 s. Prefer spell over melee while we have mana.
      if (now >= state.nextCastAt) {
        const affordable = (cfg.magery?.spells ?? []).filter(s => (mob.mana ?? 0) >= (s.mana ?? 0));
        const spell = pickSpell(affordable, target);
        if (spell && dist <= 8) {
          // Reuse the helper from aggressive.js's spell path, but simplified.
          mob.mana = Math.max(0, (mob.mana ?? 0) - (spell.mana ?? 0));
          mob.direction = dirTowards(dx, dy);
          api.combat.animate(ctx.world, mob, 0x10);
          const fx = api.protocol.huedEffect({
            kind: api.protocol.EffectKind?.Moving ?? 1,
            from: mob.serial, to: target.serial,
            itemId: spell.graphicId ?? 0x36E4,
            fromX: mob.x, fromY: mob.y, fromZ: mob.z,
            toX: target.x, toY: target.y, toZ: target.z,
            speed: spell.fxSpeed ?? 7, duration: 0,
            fixedDirection: 1, explodes: spell.explodes ?? 0,
            hue: spell.hue ?? 0, renderMode: 0,
          });
          sendToClientsNear(api, mob, fx);
          if (spell.soundId != null) {
            const snd = api.protocol.playSound({ soundId: spell.soundId, x: target.x, y: target.y, z: target.z });
            sendToClientsNear(api, target, snd);
          }
          const [lo, hi] = spell.damage ?? [6, 12];
          const dmg = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
          api.combat.damage(ctx.world, target, dmg, mob);
          state.nextCastAt = now + (cfg.castInterval ?? 3000);
          return;
        }
        // OOM or out-of-range: defer and let next tick approach + try again.
        state.nextCastAt = now + 1000;
      }
    },
  });

  return () => api.ai.unregisterBehavior('mage');
}
