import { resolveItemArg } from '../_targeting-helpers.js';
import { normalizeSkillValue } from '../../_rules.js';
import { findBackpack, isInPack } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';

// `[disenchant <serial>` — break a magic item down into its component
// magic essence. Mirrors ServUO `Imbuing` salvage flow at MVP scope:
// you don't recover the exact attributes (the imbuing pipeline is
// out of scope), but you DO recover graded essence material whose
// quality scales with the item's total intensity budget.
//
// Mechanic:
//   - target item must be in your pack and have `_magicProps[]`
//   - Tinkering skill ≥ 70 to attempt
//   - skill 70..89  → 60% chance, recover ~50% of total intensity
//   - skill 90..99  → 90% chance, recover ~75%
//   - skill 100     → 100% chance, recover full intensity
//   - failure destroys the item with no recovery
//   - success destroys the item AND spawns essence stack(s) in pack
//
// Essence grades: 1..15 → 'Magic Essence' (id 0xF7B blood moss tinted),
//                 16..40 → 'Enchanted Essence' (0xF7A black pearl tinted),
//                 41+    → 'Relic Fragment' (0x1F19 nether reagent).
//
// All three exist as ServUO types in `item-types.json`; we resolve
// graphics via the type-name resolver to stay data-driven.

const SKILL_TINKERING = 38;
const COOLDOWN_MS = 5_000;

function effectiveSkill(mob) {
  const raw = mob.skills?.[SKILL_TINKERING] ?? mob.skills?.['38'] ?? 0;
  return normalizeSkillValue(raw);
}

/** Total intensity score across props. Boolean flags count as 5. */
function totalIntensity(props) {
  if (!Array.isArray(props)) return 0;
  return props.reduce((s, p) => s + (p.isFlag ? 5 : (p.intensity ?? 0)), 0);
}

function essenceForBudget(budget) {
  if (budget <= 15)  return { type: 'MagicEssence',     fallbackItemId: 0x1F19, hue: 0x47E };
  if (budget <= 40)  return { type: 'EnchantedEssence', fallbackItemId: 0x4079, hue: 0x481 };
  return { type: 'RelicFragment', fallbackItemId: 0x1EA7, hue: 0x44E };
}

function rollSuccess(skill, rng = Math.random) {
  if (skill < 70)  return { ok: false, reason: 'unskilled', recoveryPct: 0 };
  if (skill < 90)  return { ok: rng() < 0.60, reason: null, recoveryPct: 0.50 };
  if (skill < 100) return { ok: rng() < 0.90, reason: null, recoveryPct: 0.75 };
  return { ok: true, reason: null, recoveryPct: 1.00 };
}

export default function (api) {
  const { commands } = api;
  if (!commands) return () => {};
  const cooldowns = new Map();

  commands.register({
    name: 'disenchant',
    help: '[disenchant [serial] — break a magic item into essence. No serial → cursor target.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Wave 34: cursor target fallback when called without args.
      resolveItemArg(api, ctx, 0, (item) => {
        if (!item) return;
        // Original body inlined — ctx + mob captured by closure.
      if (!Array.isArray(item._magicProps) || item._magicProps.length === 0) {
        ctx.state.sendSystemMessage('That item carries no magic to disenchant.');
        return;
      }
      const pack = findBackpack(api, mob);
      if (!pack || !isInPack(api, item, mob)) {
        ctx.state.sendSystemMessage('You can only disenchant items you carry.');
        return;
      }
      // Wave 27: locked items refuse disenchant too.
      if (item._imbueLocked) {
        ctx.state.sendSystemMessage('That item is locked and cannot be disenchanted.');
        return;
      }
      const now = Date.now();
      const cd = cooldowns.get(mob.serial) ?? 0;
      if (now < cd) {
        ctx.state.sendSystemMessage(`Steady yourself. Wait ${Math.ceil((cd - now)/1000)}s.`);
        return;
      }
      cooldowns.set(mob.serial, now + COOLDOWN_MS);

      const skill = effectiveSkill(mob);
      const { ok, reason, recoveryPct } = rollSuccess(skill);
      if (reason === 'unskilled') {
        ctx.state.sendSystemMessage('You lack the Tinkering skill (70+) to disenchant magic.');
        return;
      }

      // Destroy the item regardless of outcome — failure incinerates it.
      const total = totalIntensity(item._magicProps);
      destroyItemBySerial(api, item.serial);
      const removed = api.protocol?.removeEntity?.(item.serial);
      if (removed) ctx.state.send?.(removed);
      // Skill use → small gain pulse.
      api.skillGain?.tick?.(mob, SKILL_TINKERING);

      if (!ok) {
        ctx.state.sendSystemMessage(
          'Your hands fumble — the magic dissipates and the item is ruined.',
        );
        return;
      }

      // Spawn the essence stack(s).
      const recovered = Math.max(1, Math.floor(total * recoveryPct));
      const essence = essenceForBudget(recovered);
      const r = api.itemTypes?.resolve?.(essence.type);
      const itemId = r?.itemId ?? essence.fallbackItemId;
      const stack = api.game?.mobile?.giveItem?.(mob, {
        itemId,
        hue: essence.hue,
        amount: recovered,
        name: essence.type.replace(/([A-Z])/g, ' $1').trim().toLowerCase(),
      }, { randomGrid: true });
      if (!stack) {
        ctx.state.sendSystemMessage(
          'The magic condenses, but the essence cannot be placed in your backpack.',
        );
        return;
      }
      ctx.state.sendSystemMessage(
        `You disenchant the item, recovering ${recovered} ${essence.type}.`,
      );
      });   // close resolveItemArg cb
    },
  });

  return () => commands.unregister('disenchant');
}
