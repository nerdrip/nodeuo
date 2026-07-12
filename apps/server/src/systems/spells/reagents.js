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

import { consumeUpTo, containerChildrenRecursive } from '../../world/items.js';

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
  // Build required counts first: tables may legitimately contain the same
  // reagent more than once. Then scan the complete carried container tree.
  // The previous direct `parent === caster.serial` check only saw worn items
  // and the backpack object, never reagents inside that backpack.
  const required = new Map();
  for (const reagentId of reagents) {
    const id = reagentId | 0;
    required.set(id, (required.get(id) ?? 0) + 1);
  }
  const available = new Map();
  for (const it of containerChildrenRecursive(world, caster.serial)) {
    const id = it.itemId | 0;
    if (!required.has(id)) continue;
    available.set(id, (available.get(id) ?? 0) + Math.max(1, it.amount | 0));
  }
  for (const [id, count] of required) {
    if ((available.get(id) ?? 0) < count) return false;
  }
  // Second pass runs only after the entire cost is known to be available.
  for (const [id, count] of required) {
    consumeUpTo(world, caster.serial, (it) => (it.itemId | 0) === id, count);
  }
  return true;
}
