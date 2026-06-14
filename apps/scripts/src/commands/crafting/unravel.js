// `[unravel <serial>` — Imbuing salvage. Server parity #8 #2: ServUO
// `Imbuing.cs::OnUnravel` lets a player consume a magic weapon/armor
// to produce Magical Residue / Enchanted Essence / Relic Fragment
// proportional to its property tier. Without this command the essence
// economy was broken — Imbuing recipes registered the essence types
// but the only source was loot drops.
//
// Tier rules (ServUO defaults):
//   sum-of-intensities <  201 → 1× MagicalResidue
//   sum-of-intensities <  481 → 1× EnchantedEssence
//   sum-of-intensities ≥  481 → 1× RelicFragment
//
// Requires Imbuing 30+ (same as `[imbue`). Item is consumed on success.

import { normalizeSkillValue } from '../../_rules.js';
import { findBackpack, isInPack } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';
import { itemBySerial } from '../../_entities.js';

const SKILL_IMBUING = 57;
const MIN_SKILL = 30;

// Essence types — match `ESSENCE_TYPES` in imbue.js so the player can
// turn around and spend the unraveled essence in the same module.
const ESSENCE = {
  magic:     { itemId: 0x573C, hue: 0x000, name: 'magical residue' },
  enchanted: { itemId: 0x573C, hue: 0x481, name: 'enchanted essence' },
  relic:     { itemId: 0x573C, hue: 0x501, name: 'relic fragment' },
};

function sumIntensities(item) {
  if (!Array.isArray(item?._magicProps)) return 0;
  let total = 0;
  for (const p of item._magicProps) {
    if (p.kind === 'attr') total += (p.intensity | 0);
  }
  return total;
}

function classifyTier(total) {
  if (total >= 481) return ESSENCE.relic;
  if (total >= 201) return ESSENCE.enchanted;
  if (total >= 1)   return ESSENCE.magic;
  return null;
}

export default function (api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'unravel',
    help: '[unravel <serial> — salvage a magic item into essence (Imbuing 30+).',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const rawSkill = mob.skills?.[SKILL_IMBUING] ?? mob.skills?.[String(SKILL_IMBUING)] ?? 0;
      const skill = normalizeSkillValue(rawSkill);
      if (skill < MIN_SKILL) {
        ctx.state.sendSystemMessage(`You need at least ${MIN_SKILL} Imbuing.`);
        return;
      }
      const arg = ctx.args?.[0];
      if (!arg) {
        ctx.state.sendSystemMessage('Usage: [unravel <serial>');
        return;
      }
      const serial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
      const item = itemBySerial(api, serial);
      if (!item) { ctx.state.sendSystemMessage('No such item.'); return; }
      const pack = findBackpack(api, mob);
      if (!pack || !isInPack(api, item, mob)) {
        ctx.state.sendSystemMessage('You may only salvage items in your pack.');
        return;
      }
      const total = sumIntensities(item);
      const tier = classifyTier(total);
      if (!tier) {
        ctx.state.sendSystemMessage('That item has no magic properties to unravel.');
        return;
      }
      // Bonus essence for very-high-tier items — ServUO drops up to 4×
      // for an "imbuing-budget-full" weapon. Scale linearly.
      const bonus = total >= 481 ? 1 + Math.floor((total - 481) / 80) : 1;
      const stack = api.game?.mobile?.giveItem?.(mob, {
        itemId: tier.itemId,
        hue: tier.hue,
        name: tier.name,
        amount: bonus,
      }, { randomGrid: true });
      if (!stack) {
        ctx.state.sendSystemMessage('You have no backpack for the materials.');
        return;
      }
      // Consume the item.
      try { destroyItemBySerial(api, item.serial); }
      catch { /* gone */ }
      ctx.state.sendSystemMessage(
        `Unraveled into ${bonus}× ${tier.name}. (intensity sum ${total})`,
      );
      api.skillGain?.tryGain?.(mob, SKILL_IMBUING, 50);
    },
  });

  return () => api.commands.unregister('unravel');
}
