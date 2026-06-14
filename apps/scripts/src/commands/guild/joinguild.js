// `[joinguild thieves` — join the Thieves Guild so player-vs-player
// pickpocket and Forensic Eval `[crime` lookups work. Audit #32 P1 #2:
// `mob.npcGuild` was read in steal.js + forensic.js but never written
// anywhere — so PvP pickpocketing was permanently rejected and
// forensics always reported "not a thief", regardless of skill.
//
// ServUO models this as `PlayerMobile.NpcGuild = NpcGuild.ThievesGuild`
// joined by speaking to a Thieves Guild Master NPC after meeting the
// skill prerequisites. We collapse the NPC-adjacency dance into a
// command for MVP — gated by Stealing ≥ 60 (ServUO's GuildJoinerNPC
// minimum) and Hiding ≥ 60.

import { normalizeSkillValue } from '../../_rules.js';

const SKILL_STEALING = 34;
const SKILL_HIDING   = 22;
const GUILD_THIEVES  = 'thieves';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'joinguild',
    help: '[joinguild thieves — apply to the Thieves Guild.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const which = (ctx.args?.[0] ?? '').toLowerCase();
      if (which !== 'thieves') {
        ctx.state.sendSystemMessage('Usage: [joinguild thieves');
        return;
      }
      if (mob.npcGuild === GUILD_THIEVES) {
        ctx.state.sendSystemMessage('You are already a member of the Thieves Guild.');
        return;
      }
      const stealing = readSkill(mob, SKILL_STEALING);
      const hiding   = readSkill(mob, SKILL_HIDING);
      if (stealing < 60 || hiding < 60) {
        ctx.state.sendSystemMessage('You are not skilled enough to join the Thieves Guild (Stealing 60, Hiding 60).');
        return;
      }
      mob.npcGuild = GUILD_THIEVES;
      ctx.state.sendSystemMessage('Welcome to the Thieves Guild. Pick pockets wisely.');
    },
  });

  return () => api.commands.unregister('joinguild');
}

function readSkill(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}
