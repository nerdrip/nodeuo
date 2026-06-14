// Reagent consumption — ENGINE.
//
// Reagent TABLE (spellId → required reagent itemIds[]) is projected out
// of the unified `apps/scripts/src/data/config/spells.json` catalog and
// pushed in at startup by `apps/scripts/src/spells/reagents.js` via
// `setReagentTable`. Pre-2026-05-17 the table lived in a standalone
// `spell-reagents.json` next to `spell-names.json` and `spell-data.json`
// — all three merged into `spells.json` so there's one row per spell
// with every field a caller might need.
//
// Engine API:
//   setReagentTable(table) — replace the lookup table
//   tryConsumeReagents(world, caster, spellId) — atomic: returns false
//     if any required reagent is missing, otherwise consumes 1 of each.
//   reagentsFor(spellId) — read-back used by tooltip / gump rendering.

import { consumeUpTo } from '../../world/items.js';

/** @type {Record<number, number[]>} spellId → reagent itemIds */
let SPELL_REAGENTS = {};

export function setReagentTable(table) {
  SPELL_REAGENTS = { ...(table || {}) };
}

export function reagentsFor(spellId) {
  return SPELL_REAGENTS[spellId] ?? null;
}

/**
 * Attempt to consume all reagents required by `spellId` from the
 * caster's backpack. Atomic: scans first, only consumes if every
 * reagent is present in sufficient quantity (always 1 of each).
 *
 * Returns true if the cast may proceed (reagents consumed or none
 * required). Returns false if any reagent is missing — engine should
 * abort the cast in that case.
 */
export function tryConsumeReagents(world, caster, spellId) {
  const reagents = SPELL_REAGENTS[spellId];
  if (!reagents || reagents.length === 0) return true;
  // First pass: verify each reagent is reachable in 1+ quantity.
  for (const reagentId of reagents) {
    let found = false;
    for (const it of world.items?.values?.() ?? []) {
      if (it.parent !== caster.serial) continue;
      if (it.itemId !== reagentId) continue;
      if ((it.amount ?? 1) < 1) continue;
      found = true; break;
    }
    if (!found) return false;
  }
  // Second pass: consume 1 of each.
  for (const reagentId of reagents) {
    consumeUpTo(world, caster.serial, (it) => it.itemId === reagentId, 1);
  }
  return true;
}
