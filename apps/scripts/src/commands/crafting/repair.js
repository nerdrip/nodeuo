// PHASE EA — `[repair` command. ServUO `Engines/Craft/RepairTool.cs`
// uses a tinker tool (or smith tongs) to restore item durability.
// Each repair restores 5..15 durability and may permanently lower the
// item's max durability on a botched roll.
//
// Items track durability via two fields:
//   item.durability    — current 0..durabilityMax
//   item.durabilityMax — capped, can drop on failed repair
// Both are runtime additions; both are added to the persistence
// whitelist so a tinker's investment in keeping a sword alive
// survives restart.

import { normalizeSkillValue } from '../../_rules.js';
import { itemBySerial } from '../../_entities.js';

const SKILL_TINKERING = 38;
const SKILL_BLACKSMITHY = 8;
const SKILL_TAILORING = 35;

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'repair',
    help: '[repair — target an item to mend with the appropriate skill.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Repair which item?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('Repair cancelled.');
          return;
        }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) {
          ctx.state.sendSystemMessage('That item is not nearby.');
          return;
        }
        if (item.parent !== ctx.sender.serial) {
          ctx.state.sendSystemMessage('You can only repair items in your own pack or worn.');
          return;
        }
        if (item.durabilityMax == null) {
          ctx.state.sendSystemMessage('That item cannot be repaired.');
          return;
        }
        if ((item.durability ?? 0) >= (item.durabilityMax | 0)) {
          ctx.state.sendSystemMessage('That item is already in perfect condition.');
          return;
        }
        // Pick the appropriate skill for the item category. Heuristic
        // by itemId range — full per-item registry is PHASE J part-2.
        const skillId = pickSkillFor(item);
        const rawSkill = ctx.sender.skills?.[skillId] ?? ctx.sender.skills?.[String(skillId)] ?? 0;
        const skill = normalizeSkillValue(rawSkill);
        if (skill < 30) {
          ctx.state.sendSystemMessage('You lack the skill to attempt this repair.');
          return;
        }
        const successChance = Math.min(0.95, Math.max(0.30, skill / 100));
        if (Math.random() >= successChance) {
          // Botched repair — 30% chance of permanent durability loss.
          if (Math.random() < 0.30 && (item.durabilityMax | 0) > 1) {
            item.durabilityMax = (item.durabilityMax | 0) - 1;
            item.durability = Math.min(item.durability ?? 0, item.durabilityMax);
            ctx.state.sendSystemMessage('You botch the repair — the item is weakened.');
          } else {
            ctx.state.sendSystemMessage('You make no progress.');
          }
          api.skillGain?.tryGain?.(ctx.sender, skillId, 50);
          return;
        }
        const restored = 5 + ((Math.random() * 10) | 0);
        item.durability = Math.min(
          item.durabilityMax | 0,
          (item.durability | 0) + restored,
        );
        ctx.state.sendSystemMessage(
          `You restore the item: ${item.durability}/${item.durabilityMax}.`,
        );
        api.skillGain?.tryGain?.(ctx.sender, skillId, 60);
      }, { kind: 0 });
    },
  });

  function pickSkillFor(item) {
    const id = item.itemId | 0;
    // Cloth / leather range (Tailoring).
    if ((id >= 0x152C && id <= 0x153D) || (id >= 0x1F03 && id <= 0x1F04)) return SKILL_TAILORING;
    // Weapons / armor (Blacksmithing).
    if ((id >= 0x0F49 && id <= 0x143E) || (id >= 0x1410 && id <= 0x1417)) return SKILL_BLACKSMITHY;
    // Default to tinkering for misc tools.
    return SKILL_TINKERING;
  }

  return () => api.commands.unregister('repair');
}
