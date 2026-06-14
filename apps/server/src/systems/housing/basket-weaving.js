// Basket Weaving — port of ServUO `Scripts/Services/BasketWeaving/`. A
// craft sub-skill that uses dried reeds to assemble decorative baskets.
// We expose:
//   - `RECIPES` table (name + reeds + skill threshold + decay class)
//   - `tryWeave(state, recipeName)` → consume reeds from pack, mint
//     basket via `api.templates.spawn`, award skill use.
//
// Skill uses Tinkering as a proxy until a dedicated `weaving` slot is
// added to skills.json (ServUO uses Tinkering or Tailoring depending on
// recipe type — we pick Tinkering for the entire table for simplicity).

import { effectiveSkill } from '../../combat-formulas.js';

const SKILL_TINKERING = 38;

export const RECIPES = Object.freeze({
  'small basket':       { reeds: 4,  skill: 65,  itemId: 0x24DC, label: 'small woven basket' },
  'round basket':       { reeds: 5,  skill: 70,  itemId: 0x24DD, label: 'round basket' },
  'tall round basket':  { reeds: 7,  skill: 75,  itemId: 0x24DE, label: 'tall round basket' },
  'square basket':      { reeds: 6,  skill: 75,  itemId: 0x24DF, label: 'square basket' },
  'bushel basket':      { reeds: 9,  skill: 85,  itemId: 0x24E0, label: 'bushel basket' },
  'tall flared basket': { reeds: 11, skill: 95,  itemId: 0x24E1, label: 'tall flared basket' },
  'small handled':      { reeds: 6,  skill: 80,  itemId: 0x24E2, label: 'small handled basket' },
  'large handled':      { reeds: 10, skill: 90,  itemId: 0x24E3, label: 'large handled basket' },
});

export function recipeNames() { return Object.keys(RECIPES); }
export function recipe(name) { return RECIPES[String(name).toLowerCase()] ?? null; }

function packHas(pack, label, n) {
  let total = 0;
  for (const it of pack?.contents?.() ?? []) {
    if (String(it.label || '').toLowerCase() === label) {
      total += it.amount ?? 1;
      if (total >= n) return true;
    }
  }
  return total >= n;
}

function packTake(pack, label, n) {
  let need = n;
  for (const it of (pack?.contents?.() ?? []).slice()) {
    if (need <= 0) break;
    if (String(it.label || '').toLowerCase() !== label) continue;
    const take = Math.min(need, it.amount ?? 1);
    if (it.amount && it.amount > take) it.amount -= take;
    else pack?.remove?.(it);
    need -= take;
  }
  return n - need;
}

export function tryWeave(state, recipeName, api) {
  const r = recipe(recipeName);
  if (!r) return { ok: false, reason: 'Unknown recipe.' };
  const skill = effectiveSkill(state?.mobile, SKILL_TINKERING);
  if (skill < r.skill) {
    return { ok: false, reason: `Tinkering ${r.skill} required.` };
  }
  const pack = state?.mobile?.backpack ?? state?.mobile?.equipment?.get?.(21);
  if (!packHas(pack, 'driedreeds', r.reeds)) {
    return { ok: false, reason: `Need ${r.reeds} dried reeds.` };
  }
  packTake(pack, 'driedreeds', r.reeds);
  // Roll skill check; failure consumes reeds (ServUO behaviour).
  const chance = Math.min(95, Math.max(5, skill - r.skill + 50));
  if (Math.random() * 100 > chance) return { ok: false, reason: 'Your weaving slips and the basket falls apart.' };
  api?.templates?.spawn?.('basket', {
    container: pack, amount: 1,
    overrides: { itemId: r.itemId, label: r.label },
  });
  return { ok: true, label: r.label };
}
