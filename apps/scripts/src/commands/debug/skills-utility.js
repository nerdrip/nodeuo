// Small utility skill commands that do not have their own subsystem-backed
// module. Bard actions intentionally live in `commands/economy/bard.js`;
// keeping fallback peace/provoke/discord implementations here made load order
// choose different game rules after every script reshuffle.

import { normalizeSkillValue } from '../../_rules.js';
import { allMobiles } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';

const SKILLS = {
  ITEM_ID: 4,
  VETERINARY: 40,
  MEDITATION: 47,
};

function skillOf(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  api.commands.register({
    name: 'id', help: '[id — identify an item.', access: 'Player',
    run(ctx) {
      api.targeting?.request?.(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) return;
        const templateName = item.template ?? '?';
        ctx.state.sendSystemMessage(
          `Item ${item.name ?? '?'} — itemId 0x${(item.itemId | 0).toString(16)}, template=${templateName}`,
        );
        api.skillGain?.tryGain?.(ctx.sender, SKILLS.ITEM_ID, 50);
      }, { kind: 0 });
    },
  });

  api.commands.register({
    name: 'heal-pet', help: '[heal-pet — bandage an adjacent pet.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      let pet = null;
      for (const candidate of allMobiles(api)) {
        if ((candidate.controlMaster >>> 0) !== (mob.serial >>> 0)) continue;
        if (distance(candidate, mob) > 1) continue;
        pet = candidate;
        break;
      }
      if (!pet) {
        ctx.state.sendSystemMessage('No pet adjacent.');
        return;
      }
      if (pet.ghost) {
        if (!pet.bonded) {
          ctx.state.sendSystemMessage('That pet has no soul-bond — only bonded pets can be revived.');
          return;
        }
        if (api.ctx?.corpse?.resurrectMobile) {
          api.ctx.corpse.resurrectMobile(api.world, pet, mob);
          ctx.state.sendSystemMessage(`${pet.name ?? 'your pet'} returns to your side.`);
        }
        api.skillGain?.tryGain?.(mob, SKILLS.VETERINARY, 80);
        return;
      }
      const heal = 20 + Math.floor(skillOf(mob, SKILLS.VETERINARY) / 4);
      pet.hp = Math.min(pet.hpMax ?? 50, (pet.hp ?? 0) + heal);
      ctx.state.sendSystemMessage(`You patch ${pet.name ?? 'your pet'} for ${heal}.`);
      api.skillGain?.tryGain?.(mob, SKILLS.VETERINARY, 60);
    },
  });

  api.commands.register({
    name: 'meditate', help: '[meditate — focus your spirit to recover mana faster.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      api.statusEffects?.apply?.(mob, { name: 'meditation', durationMs: 30_000 });
      ctx.state.sendSystemMessage('You enter a meditative trance.');
      api.skillGain?.tryGain?.(mob, SKILLS.MEDITATION, 50);
    },
  });

  return () => {
    for (const name of ['id', 'heal-pet', 'meditate']) api.commands.unregister(name);
  };
}
