// Bard AI — Provocation between two enemies, Peacemaking AOE calm,
// Discordance debuff. ServUO: AIType.Bard wraps these into a unified
// caster-style behavior. Our cut: tick picks the cheapest applicable
// ability, falls back to wander when no targets in range.
//
// Required mob fields:
//   skills[16] = Discordance, skills[23] = Provocation, skills[10] = Peacemaking
//   instrumentQuality (0..100, set by data) — multiplies success chance.

import { normalizeSkillValue } from '../../_rules.js';
import { nearbyMobiles } from '../../_spatial.js';

const SKILL_PEACEMAKING = 10;
const SKILL_DISCORDANCE = 16;
const SKILL_PROVOCATION = 23;

function skillOf(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

function nearbyEnemies(api, world, mob, range) {
  const out = [];
  const candidates = nearbyMobiles(api, mob, mob, range);
  for (const m of candidates) {
    if (m === mob || m.map !== mob.map) continue;
    if ((m.hp ?? 0) <= 0 || m.ghost) continue;
    if ((m.notoriety ?? 1) < 4 && !m.client) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d <= range) out.push({ m, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai) return () => {};

  api.ai.registerBehavior({
    name: 'bard',
    initState() {
      return { nextActAt: 0, nextStepAt: 0, home: null,
        provoTargetSerial: 0, provoVictimSerial: 0 };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const now = ctx.now;

      const range = mob.bardRange ?? 8;
      const cooldown = mob.bardCooldown ?? 4000;
      const enemies = nearbyEnemies(api, ctx.world, mob, range);

      // No enemies — drift home.
      if (enemies.length === 0) {
        if (now < state.nextStepAt) return;
        state.nextStepAt = now + 800;
        const dx = state.home.x - mob.x;
        const dy = state.home.y - mob.y;
        if (Math.abs(dx) + Math.abs(dy) > 1) {
          if (api.ai.stepMobile?.(mob, dirTowards(dx, dy))) ctx.broadcastMove(mob);
        }
        return;
      }

      if (now < state.nextActAt) return;
      state.nextActAt = now + cooldown;

      const skillProv = skillOf(mob, SKILL_PROVOCATION);
      const skillPeace = skillOf(mob, SKILL_PEACEMAKING);
      const skillDisc = skillOf(mob, SKILL_DISCORDANCE);
      const inst = (mob.instrumentQuality ?? 50) / 100;

      // Prefer Provocation if 2 enemies near each other.
      if (enemies.length >= 2 && skillProv >= 50) {
        const a = enemies[0].m, b = enemies[1].m;
        const between = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        if (between <= 5 && Math.random() < (skillProv / 120) * inst) {
          // Set b as a's combat target — uses world.combat or sets attack flag.
          a.combatTarget = b.serial;
          b.combatTarget = a.serial;
          ctx.broadcastSpeech?.(mob, '*plays a battle hymn*', 0x481);
          return;
        }
      }

      // Discordance — debuff one enemy's skills.
      if (skillDisc >= 30 && Math.random() < (skillDisc / 100) * inst) {
        const v = enemies[0].m;
        v._discordedUntil = Date.now() + 30_000;
        v._discordPenaltyPct = Math.min(0.30, Math.max(0.05, skillDisc / 500));
        ctx.broadcastSpeech?.(mob, '*plays a discordant tune*', 0x481);
        return;
      }

      // Peacemaking — calm everyone in earshot.
      if (skillPeace >= 30 && Math.random() < (skillPeace / 100) * inst) {
        for (const { m } of enemies) {
          m._peacefulUntil = Date.now() + 8000;
          m.combatTarget = 0;
        }
        ctx.broadcastSpeech?.(mob, '*plays a soothing melody*', 0x481);
      }
    },
  });

  return () => api.ai.unregisterBehavior('bard');
}
