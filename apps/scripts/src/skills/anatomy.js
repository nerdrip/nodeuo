// `[anatomy <mob>` — target a mobile, returns hit points / stat estimate.
// Mirrors ServUO `Anatomy.cs::OnUse` which prints a string like
// "You judge them to be in great health" + a vague stat band based on
// the user's Anatomy skill.

import { normalizeSkillValue } from '../_rules.js';
import { mobileBySerial } from '../_entities.js';

const SKILL_ANATOMY = 2;

function describeHealth(ratio) {
  if (ratio >= 0.95) return 'in perfect health';
  if (ratio >= 0.75) return 'in great health';
  if (ratio >= 0.50) return 'wounded';
  if (ratio >= 0.25) return 'badly wounded';
  return 'almost dead';
}

function describeStat(value, skillTier) {
  // Fuzzy buckets — high-skill anatomy reveals tighter ranges.
  if (skillTier >= 80) return ` (${value | 0})`;
  if (skillTier >= 50) {
    const lo = Math.max(0, (value | 0) - 10);
    const hi = (value | 0) + 10;
    return ` (about ${lo}-${hi})`;
  }
  if (value < 30) return ' (weak)';
  if (value < 60) return ' (average)';
  if (value < 90) return ' (strong)';
  return ' (mighty)';
}

export default function register(api) {
  if (!api.commands?.register || !api.targeting?.request) return () => {};
  api.commands.register({
    name: 'anatomy',
    help: '[anatomy — target a creature to judge their condition.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      ctx.state.sendSystemMessage('Anatomise whom?');
      api.targeting.request(ctx.state, (picked) => {
        const target = mobileBySerial(api, picked?.serial >>> 0);
        if (!target) { ctx.state.sendSystemMessage('No such target.'); return; }
        const skill = normalizeSkillValue(
          mob.skills?.[SKILL_ANATOMY] ?? mob.skills?.[String(SKILL_ANATOMY)] ?? 0,
        );
        // Skill check — gain a chance proportional to mob HP (harder
        // to read on a fresh creature than a heavily-wounded one).
        const difficulty = 30 + Math.floor((target.hpMax ?? 50) / 5);
        if (skill < 10) {
          ctx.state.sendSystemMessage('You have no idea what to look for.');
          return;
        }
        const ratio = (target.hp ?? 0) / Math.max(1, target.hpMax ?? 50);
        let line = `You judge ${target.name ?? 'them'} to be ${describeHealth(ratio)}.`;
        if (skill >= 30) {
          line += ` Strength${describeStat(target.str ?? 0, skill)},`;
          line += ` dexterity${describeStat(target.dex ?? 0, skill)},`;
          line += ` intelligence${describeStat(target.int ?? 0, skill)}.`;
        }
        ctx.state.sendSystemMessage(line);
        try { api.combat?.awardSkill?.(mob, SKILL_ANATOMY, difficulty); }
        catch { /* skill gain advisory */ }
      }, { kind: 0 });
    },
  });
  return () => api.commands.unregister?.('anatomy');
}
