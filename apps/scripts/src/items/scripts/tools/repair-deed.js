// Repair deed — ServUO `Items/Consumables/RepairDeed.cs`. A skill-
// gated consumable that restores a chunk of durability on a weapon
// or armor. Each deed is bound to a craft skill (blacksmithy /
// tailoring / carpentry) and uses that skill for the chance roll.

import { normalizeSkillValue } from '../../../_rules.js';
import { destroyItemBySerial } from '../../../_items.js';
import { itemBySerial } from '../../../_entities.js';

const SKILL_BLACKSMITHY = 8;
const SKILL_TAILORING   = 35;
const SKILL_CARPENTRY   = 12;
const SKILL_TINKERING   = 38;

// `repairWith` -> required skill id.
const SKILL_BY_KIND = {
  smith:     SKILL_BLACKSMITHY,
  tailor:    SKILL_TAILORING,
  carpentry: SKILL_CARPENTRY,
  tinker:    SKILL_TINKERING,
};

export default function buildRepairDeedScript(api) {
  return {
    name: 'repair-deed',
    onUse(world, item, user) {
      if (!user) return true;
      const kind = item.repairKind ?? 'smith';
      const skillId = SKILL_BY_KIND[kind] ?? SKILL_BLACKSMITHY;
      const rawSkill = user.skills?.[skillId] ?? user.skills?.[String(skillId)] ?? 0;
      const skill = normalizeSkillValue(rawSkill);
      if (skill < 30) {
        user.client?.sendSystemMessage?.('You lack the skill to use this deed.');
        return true;
      }
      user.client?.sendSystemMessage?.('Select the item to repair.');
      api.targeting.request(user.client, (picked) => {
        if (!picked || !picked.serial) return;
        const it = itemBySerial({ world }, picked.serial);
        if (!it || it.durability == null) {
          user.client?.sendSystemMessage?.('That cannot be repaired.');
          return;
        }
        if (it.parent !== user.serial && it.layer === 0) {
          user.client?.sendSystemMessage?.('You can only repair your own gear.');
          return;
        }
        const max = it.durabilityMax ?? 50;
        if ((it.durability | 0) >= max) {
          user.client?.sendSystemMessage?.('That is already in perfect condition.');
          return;
        }
        // ServUO chance formula simplified: high skill repairs more,
        // low skill risks reducing the durability cap.
        const success = Math.random() < Math.max(0.2, skill / 100);
        if (success) {
          const heal = Math.min(max - it.durability, 10 + Math.floor(skill / 10));
          it.durability = (it.durability | 0) + heal;
          user.client?.sendSystemMessage?.(`Repaired (+${heal} durability).`);
        } else if (Math.random() < 0.3) {
          // Botched repair — permanent durability cap loss.
          it.durabilityMax = Math.max(1, max - 1);
          if (it.durability > it.durabilityMax) it.durability = it.durabilityMax;
          user.client?.sendSystemMessage?.('You botch the repair and weaken the item permanently.');
        } else {
          user.client?.sendSystemMessage?.('The repair fails but no harm is done.');
        }
        destroyItemBySerial(api, item.serial);
      });
      return true;
    },
  };
}
