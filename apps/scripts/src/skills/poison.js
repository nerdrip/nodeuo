// `[poison <weapon-serial> [level]` — Poisoning skill (ServUO
// Skills/Poisoning.cs). Applies a poison charge to a wielded weapon.
//
// Server flow without a UI yet: player issues `[poison`; the next
// targeting prompt picks the weapon (or food/dart). A poison potion
// in pack is consumed. Skill check determines success + level.
//
// Levels (ServUO BasePoisonPotion):
//   0 lesser   (50  poisoning)
//   1 normal   (65 poisoning)
//   2 greater  (80 poisoning)
//   3 deadly   (95 poisoning)
//   4 lethal   (110 poisoning, AOS only)

import { normalizeSkillValue } from '../_rules.js';
import { isPackedOrWorn, packItems } from '../_inventory.js';
import { destroyItemBySerial } from '../_items.js';
import { itemBySerial } from '../_entities.js';

const SKILL_POISONING = 31;
const POISON_POTION_IDS = {
  // ItemId → potion-level. ServUO PotionType{ Greater/...}.
  0x0F0A: 0, // lesser poison potion (yellow)
  0x0F0B: 1, // normal poison potion
  0x0F0C: 2, // greater poison potion (deadly)
  0x0F0D: 3, // deadly poison potion (purple)
};

function potionLevelOf(item) {
  if (!item) return null;
  if (item.poisonLevel != null) return Math.max(0, Math.min(4, item.poisonLevel | 0));
  if (item.script === 'potion-poison') return 1;
  const tag = String(item.tagId ?? '').toLowerCase();
  if (tag.includes('lethal') || tag.includes('darkglow') || tag.includes('parasitic')) return 4;
  if (tag.includes('deadly')) return 3;
  if (tag.includes('greater')) return 2;
  if (tag.includes('lesser')) return 0;
  const name = String(item.name ?? '').toLowerCase();
  if (!name.includes('poison')) return POISON_POTION_IDS[item.itemId | 0] ?? null;
  if (name.includes('lethal') || name.includes('darkglow') || name.includes('parasitic')) return 4;
  if (name.includes('deadly')) return 3;
  if (name.includes('greater')) return 2;
  if (name.includes('lesser')) return 0;
  return 1;
}

export default function register(api) {
  if (!api.commands || !api.world || !api.targeting) return () => {};

  api.commands.register({
    name: 'poison',
    help: '[poison — apply a poison potion from your pack to a wielded weapon.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      if (!sender) return;
      const rawSkill = sender.skills?.[SKILL_POISONING] ?? sender.skills?.[String(SKILL_POISONING)] ?? 0;
      const skill = normalizeSkillValue(rawSkill);
      if (skill < 30) {
        ctx.state.sendSystemMessage('You lack the skill to apply poison safely.');
        return;
      }
      // Find the highest-tier poison potion in the pack.
      let potion = null;
      let level = -1;
      for (const it of packItems(api, sender)) {
        const lvl = potionLevelOf(it);
        if (lvl == null) continue;
        if (lvl > level) { potion = it; level = lvl; }
      }
      if (!potion) {
        ctx.state.sendSystemMessage('You have no poison potion in your pack.');
        return;
      }
      ctx.state.sendSystemMessage('Select the weapon to poison.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('Cancelled.');
          return;
        }
        const wpn = itemBySerial(api, picked.serial >>> 0);
        if (!wpn) {
          ctx.state.sendSystemMessage('Invalid target.');
          return;
        }
        const ownsWeapon = isPackedOrWorn(api, wpn, sender);
        if (!ownsWeapon) {
          ctx.state.sendSystemMessage('You can only poison a weapon you own.');
          return;
        }
        if (!wpn.weapon) {
          ctx.state.sendSystemMessage('That is not a weapon.');
          return;
        }
        // Skill check vs required threshold per level. ServUO formula:
        //   chance = (skill - reqMin) / (reqMax - reqMin)
        const reqMin = 30 + level * 20;
        const reqMax = 60 + level * 20;
        const chance = Math.max(0.05, Math.min(0.95, (skill - reqMin) / (reqMax - reqMin)));
        if ((potion.amount | 0) > 1) {
          potion.amount -= 1;
          try { api.broadcast?.itemUpdate?.(api.world, potion); } catch { /* advisory */ }
        } else {
          destroyItemBySerial(api, potion.serial);
        }
        if (Math.random() > chance) {
          ctx.state.sendSystemMessage('You fail to apply the poison and the potion is wasted.');
          return;
        }
        wpn.poison = {
          level,
          kind: potion.poisonKind ?? 'poison',
          charges: potion.poisonCharges ?? (8 + Math.floor(Math.random() * 9)),
        };
        wpn.poisonLevel = wpn.poison.level;
        wpn.poisonCharges = wpn.poison.charges;
        ctx.state.sendSystemMessage(`The weapon glistens with poison (level ${level + 1}, ${wpn.poison.charges} charges).`);
      });
    },
  });

  return () => {
    api.commands.unregister('poison');
  };
}
