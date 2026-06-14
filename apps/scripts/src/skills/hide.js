// `[hide` — attempt to vanish from sight using the Hiding skill.
//
// ServUO formula: difficulty 0..80 depending on whether you've recently
// fought, ambient light, etc. We model just the skill check: chance =
// (Hiding - 0) / 80, clamped. On success the mob is removed from every
// nearby client's view (see _visibility.hide) and the Hiding skill is
// awarded against difficulty 50.

import { hide } from '../_visibility.js';
import { normalizeSkillValue } from '../_rules.js';

const SKILL_HIDING = 22;

function skillOf(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.protocol) return () => {};

  api.commands.register({
    name: 'hide',
    help: '[hide — attempt to conceal yourself.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      if (mob.hidden) {
        ctx.state.sendSystemMessage('You are already hidden.');
        return;
      }
      if ((mob.flags & 0x40) !== 0) {
        ctx.state.sendSystemMessage('You cannot hide while in war mode.');
        return;
      }
      // Audit #41 P3 #37 — ServUO `Hiding.cs::OnUse` refuses for 10s
      // after the last attack/spell-cast against another player. Was:
      // hide-out-of-combat trivialised PvP escape.
      if ((mob._lastPvPAt ?? 0) + 10_000 > Date.now()) {
        ctx.state.sendSystemMessage('You are too close to combat to hide.');
        return;
      }
      const skill = skillOf(mob, SKILL_HIDING);
      // 0 skill → 0% (always fails); 80+ → 100%.
      const chance = Math.min(1, Math.max(0, skill / 80));
      const award = api.combat?.awardSkill;
      if (Math.random() >= chance) {
        ctx.state.sendSystemMessage('You cannot seem to hide here.');
        // Half-rate gain on failure, like every other skill in the codebase.
        if (mob.skills && Math.random() < 0.5) award?.(mob, SKILL_HIDING, 50);
        return;
      }
      hide(api, mob);
      ctx.state.sendSystemMessage('You have hidden yourself well.');
      if (mob.skills) award?.(mob, SKILL_HIDING, 50);
    },
  });

  return () => api.commands.unregister('hide');
}
