// `[setskill <id> <value>` — admin command to set one of the sender's skills.
// Also `[skills` to dump the current skill table.
//
// Skill ids in this codebase are **1-based** (matching `Skills.mul` / the
// 0x3A wire format), to keep storage and wire conventions identical and
// avoid +1 conversions all over the place. The starter-skill template in
// handlers.js uses the same convention (Magery = 26, Tactics = 28, etc.)
// — combat-formulas.js, cast.js and regen.js all read with these ids.

import { normalizeSkillValue } from '../../_rules.js';

const SKILL_NAMES = {
  1: 'Alchemy', 2: 'Anatomy', 3: 'Animal Lore', 4: 'Item ID', 5: 'Arms Lore',
  6: 'Parry', 7: 'Begging', 8: 'Blacksmith', 9: 'Bowcraft', 10: 'Peacemaking',
  11: 'Camping', 12: 'Carpentry', 13: 'Cartography', 14: 'Cooking', 15: 'Detect Hidden',
  16: 'Discordance', 17: 'Evaluating Intelligence', 18: 'Healing', 19: 'Fishing', 20: 'Forensic Evaluation',
  21: 'Herding', 22: 'Hiding', 23: 'Provocation', 24: 'Inscription', 25: 'Lockpicking',
  26: 'Magery', 27: 'Magic Resistance', 28: 'Tactics', 29: 'Snooping', 30: 'Musicianship',
  31: 'Poisoning', 32: 'Archery', 33: 'Spirit Speak', 34: 'Stealing', 35: 'Tailoring',
  36: 'Animal Taming', 37: 'Taste Identification', 38: 'Tinkering', 39: 'Tracking', 40: 'Veterinary',
  41: 'Swordsmanship', 42: 'Mace Fighting', 43: 'Fencing', 44: 'Wrestling', 45: 'Lumberjacking',
  46: 'Mining', 47: 'Meditation', 48: 'Stealth', 49: 'Remove Trap', 50: 'Necromancy',
  51: 'Focus', 52: 'Chivalry',
  // BUGFIX #111 (PHASE GA): SA/ML schools were missing from the skill
  // name dictionary — `[skills` printed "Skill 53: 80" instead of
  // "Bushido: 80". Players had to memorise the numeric ids.
  53: 'Bushido', 54: 'Ninjitsu', 55: 'Spellweaving', 56: 'Mysticism',
  57: 'Imbuing', 58: 'Throwing',
};

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.protocol) return () => {};

  api.commands.register({
    name: 'setskill',
    help: '[setskill <id> <value> — set a skill on yourself (value in 0..120).',
    run(ctx, args) {
      if (args.length < 2) {
        ctx.state.sendSystemMessage('Usage: [setskill <id> <value>');
        return;
      }
      const id = parseInt(args[0], 10);
      const v = parseFloat(args[1]);
      if (!Number.isFinite(id) || id < 1 || id > 58) {
        ctx.state.sendSystemMessage('Invalid skill id (1..58).');
        return;
      }
      if (!Number.isFinite(v) || v < 0 || v > 120) {
        ctx.state.sendSystemMessage('Value must be 0..120.');
        return;
      }
      ctx.sender.skills = ctx.sender.skills ?? {};
      ctx.sender.skills[id] = v;
      const label = SKILL_NAMES[id] ?? `skill ${id}`;
      ctx.state.send(api.protocol.sendSkills({
        skills: [{ id, value: v, base: v, cap: 100 }],
        type: 0xFF, // single-skill update
      }));
      ctx.state.sendSystemMessage(`${label} set to ${v.toFixed(1)}.`);
    },
  });

  api.commands.register({
    name: 'skills',
    help: '[skills — list your current skill values.',
    access: 'Player',
    run(ctx) {
      const skills = ctx.sender.skills ?? {};
      const rows = Object.entries(skills).sort((a, b) => a[0] - b[0]);
      if (!rows.length) {
        ctx.state.sendSystemMessage('No skills set. Try [setskill 25 100.');
        return;
      }
      for (const [idStr, value] of rows) {
        const id = Number(idStr);
        const label = SKILL_NAMES[id] ?? `skill ${id}`;
        ctx.state.sendSystemMessage(`  ${label}: ${normalizeSkillValue(value).toFixed(1)}`);
      }
    },
  });

  return () => {
    api.commands.unregister('setskill');
    api.commands.unregister('skills');
  };
}
