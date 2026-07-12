// Evaluating Intelligence — `[evalint`.
// Anatomy, Arms Lore and Taste Identification have their canonical,
// fuller implementations in skills/{anatomy,lore,tasteid}.js. Keeping a
// second copy here made command ownership depend on filesystem load order.

import { normalizeSkillValue } from '../../_rules.js';
import { mobileBySerial } from '../../_entities.js';

const SKILL_EVALINT  = 17;

function describeMana(target, skill) {
  const mana = target.mana | 0;
  const max  = target.manaMax | 0;
  const intel = target.intel | 0;
  if (skill < 30) return `${target.name ?? 'creature'} appears mentally ordinary.`;
  if (skill < 70) return `${target.name ?? 'creature'} — mana ~${Math.round(mana / 5) * 5}/${max}.`;
  return `${target.name ?? 'creature'} — Int ${intel}, Mana ${mana}/${max}.`;
}

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  function infoCmd(name, skillId, help, handler) {
    api.commands.register({
      name, help, access: 'Player',
      run(ctx) {
        const sender = ctx.sender;
        const rawSkill = sender.skills?.[skillId] ?? sender.skills?.[String(skillId)] ?? 0;
        const skill = normalizeSkillValue(rawSkill);
        if (skill < 1) {
          ctx.state.sendSystemMessage(`You have no skill in that.`);
          return;
        }
        ctx.state.sendSystemMessage('Select a target.');
        api.targeting.request(ctx.state, (picked) => {
          if (!picked) return;
          const sub = picked.serial ? mobileBySerial(api, picked.serial) : null;
          if (!sub) { ctx.state.sendSystemMessage('Invalid target.'); return; }
          ctx.state.sendSystemMessage(handler(sub, skill));
        });
      },
    });
  }

  infoCmd('evalint', SKILL_EVALINT, '[evalint — gauge a target\'s mana / intellect.', describeMana);

  return () => {
    api.commands.unregister('evalint');
  };
}
