// `[tasteid` — Taste Identification skill (id 37). ServUO
// Skills/TasteID.cs: targets a food / drink / potion and reveals its
// poison level. Implementation is dead-simple — read `item.poison` (set
// by Poisoning skill or item template) and message back.

import { normalizeSkillValue } from '../_rules.js';
import { itemBySerial } from '../_entities.js';

const SKILL_TASTEID = 37;

function readSkill(mob, id) {
  if (!mob?.skills) return 0;
  const raw = mob.skills[id] ?? mob.skills[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.targeting || !api.world) return () => {};

  api.commands.register({
    name: 'tasteid',
    help: '[tasteid — taste an item to detect poison.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      ctx.state.sendSystemMessage('Taste what?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it) {
          ctx.state.sendSystemMessage('You can only taste an item.');
          return;
        }
        const skill = readSkill(mob, SKILL_TASTEID);
        if (Math.random() * 100 > skill) {
          ctx.state.sendSystemMessage('You cannot tell anything about it.');
          api.skillGain?.tryGain?.(mob, SKILL_TASTEID, 0.5);
          return;
        }
        const lvl = it.poison | 0;
        if (!lvl) {
          ctx.state.sendSystemMessage('It looks safe to eat.');
        } else {
          const labels = ['lesser', 'regular', 'greater', 'deadly', 'lethal'];
          ctx.state.sendSystemMessage(`You taste ${labels[Math.min(lvl - 1, labels.length - 1)] ?? 'unknown'} poison.`);
        }
        api.skillGain?.tryGain?.(mob, SKILL_TASTEID, 1.0);
      });
    },
  });

  return () => api.commands.unregister('tasteid');
}
