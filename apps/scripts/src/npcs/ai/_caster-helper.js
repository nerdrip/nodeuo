// Generic caster AI helper. Mirrors ServUO's MagicalAI base
// (`Mobiles/AI/Magical AI/*.cs`) — every concrete caster (MageAI,
// NecroAI, MysticAI, …) is a thin override on top of the same loop:
// keep range, regen mana, pick a spell tier'd by target HP, cast,
// fall back to melee when OOM. The variant school provides the
// spell roster and a couple of constants (cast cadence, ideal range).
//
// Each per-school AI module wires this once and re-exports the
// behavior's name. Mob configs in `monsters.json` opt in by setting
// `aiKind: 'mystic' | 'necro' | 'necromage' | 'paladin' | 'samurai'
// | 'spellbinder' | 'spellweaving'`.

import { nearbyClients, nearbyMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function findNearestPlayer(api, world, mob, range) {
  let best = null, bestDist = range + 1;
  // Friend gate — same shape as `aggressive.js#findNearestPlayer`. When
  // a caster AI runs on a summoned creature (future Daemon-summon
  // promotion or a tamed-summoner mage), team/summonedBy/controlMaster
  // identify the friendly party. Without this an Energy Vortex hosted
  // by a mage-AI would target its own caster.
  const myTeam        = mob.team | 0;
  const summonedBy    = mob.summonedBy >>> 0;
  const controlMaster = mob.controlMaster >>> 0;
  const candidates = nearbyMobiles(api?.world ? api : world, mob, mob, range);
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

/**
 * @param {object} api
 * @param {object} opts
 * @param {string} opts.name             Behavior id (`'mystic'`, `'necro'` …)
 * @param {string} opts.spellsField      Mob config field that carries spells (`'mysticism.spells'`).
 * @param {Array}  opts.fallbackSpells   Default spell list when mob has none.
 * @param {number} [opts.castIntervalMs] Default 3000.
 * @param {number} [opts.idealRange]     Default 5.
 * @param {(mob, target, ctx)=>boolean} [opts.preCast] Optional self-buff hook fired BEFORE pickSpell.
 */
export function registerCasterBehavior(api, opts) {
  const {
    name, spellsField, fallbackSpells,
    castIntervalMs = 3000, idealRange = 5, preCast,
  } = opts;

  const fallbackCfg = {
    name: `a ${name}`, body: 0x0190, hue: 0, hp: 60, mana: 60, manaMax: 60,
    aggroRange: 10, attackInterval: 1500,
  };
  // Resolve a dotted field path (`'mysticism.spells'`) safely.
  function readSpells(cfg) {
    if (!cfg) return null;
    let cur = cfg;
    for (const k of spellsField.split('.')) cur = cur?.[k];
    return Array.isArray(cur) ? cur : null;
  }

  api.ai.registerBehavior({
    name,
    initState() {
      return { kind: null, targetSerial: 0, nextCastAt: 0, nextStepAt: 0, home: null };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const cfg = api.monsters?.get(state.kind) ?? fallbackCfg;
      const now = ctx.now;

      // Mana regen — matches PlayerMobile baseline (0.05/s).
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

      if (now >= state.nextStepAt) {
        state.nextStepAt = now + 250;
        if (dist > idealRange + 1) {
          api.ai.stepMobile?.(mob, dirTowards(dx, dy));
          ctx.broadcastMove(mob);
        } else if (dist < idealRange - 1) {
          api.ai.stepMobile?.(mob, dirTowards(-dx, -dy));
          ctx.broadcastMove(mob);
        }
      }

      if (now >= state.nextCastAt) {
        // Optional school-specific self-buff (ConsecrateWeapon, DivineFury,
        // SamuraiMove activation). Returns true to consume the slot.
        if (preCast && preCast(mob, target, ctx)) {
          state.nextCastAt = now + castIntervalMs;
          return;
        }
        const spells = readSpells(cfg) ?? fallbackSpells;
        const affordable = spells.filter(s => (mob.mana ?? 0) >= (s.mana ?? 0));
        if (affordable.length === 0 || dist > 9) {
          state.nextCastAt = now + 1000;
          return;
        }
        const hpFrac = (target.hp ?? 0) / Math.max(1, target.hpMax ?? 1);
        const tier = hpFrac > 0.8 ? 1 : hpFrac > 0.5 ? 2 : hpFrac > 0.2 ? 3 : 4;
        const ranked = [...affordable].sort((a, b) =>
          (b.damage?.[1] ?? 0) - (a.damage?.[1] ?? 0));
        const cap = tier === 1 ? Math.ceil(ranked.length / 2)
                  : tier === 2 ? Math.max(1, ranked.length - 1)
                  : ranked.length;
        const spell = ranked.slice(0, cap)[0] ?? ranked[0];
        if (!spell) { state.nextCastAt = now + 1000; return; }

        mob.mana = Math.max(0, (mob.mana ?? 0) - (spell.mana ?? 0));
        mob.direction = dirTowards(dx, dy);
        api.combat.animate(ctx.world, mob, spell.castAnim ?? 0x10);

        const fx = api.protocol.huedEffect({
          kind: api.protocol.EffectKind?.Moving ?? 1,
          from: mob.serial, to: target.serial,
          itemId: spell.graphicId ?? 0x36E4,
          fromX: mob.x, fromY: mob.y, fromZ: mob.z,
          toX: target.x, toY: target.y, toZ: target.z,
          speed: spell.fxSpeed ?? 7, duration: 0,
          fixedDirection: 1, explodes: spell.explodes ?? 0,
          hue: spell.hue ?? 0, renderMode: spell.blend ?? 0,
        });
        for (const o of nearbyClients(api, mob)) {
          o.client.send(fx);
        }
        if (spell.soundId != null) {
          const snd = api.protocol.playSound({ soundId: spell.soundId, x: target.x, y: target.y, z: target.z });
          for (const o of nearbyClients(api, target)) o.client.send(snd);
        }
        const [lo, hi] = spell.damage ?? [6, 12];
        const dmg = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
        api.combat.damage(ctx.world, target, dmg, mob);

        // Bonus: status effects (poison/curse/strangle DoT). Plug the
        // spell entry: `effect: { name, durationMs, data? }`.
        if (spell.effect && api.statusEffects?.add) {
          api.statusEffects.add(target, {
            name: spell.effect.name,
            durationMs: spell.effect.durationMs ?? 8000,
            expiresAt: now + (spell.effect.durationMs ?? 8000),
            data: spell.effect.data ?? {},
          });
        }

        state.nextCastAt = now + (cfg.castInterval ?? castIntervalMs);
      }
    },
  });

  return () => api.ai.unregisterBehavior(name);
}
