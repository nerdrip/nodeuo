// Armor refinement — Stygian Abyss feature. Players gather "refinement
// components" (dropped by SA mobs / Void invasions) and combine them at
// an Imbuing-style station to bond a refinement onto a piece of armor.
// Each piece can hold ONE refinement; refinements add 1-25 to one resist
// at the cost of -1 to a paired resist. ServUO source: Scripts/Services/
// Expansions/SA/Refinement/RefinementComponent.cs.
//
// Wiring:
//   - `applyRefinement(item, resist, amount)` mutates item._refinement +
//     boosts item.resists.<resist> by amount, deducts the paired resist.
//   - `removeRefinement(item)` reverses both deltas.
//   - `refinementFor(item)` returns the current refinement entry or null.
//   - Persistence layer already serialises any `_refinement` field via the
//     ALLOWED_ITEM_KEYS allowlist (extension key hook in persistence.js).
//
// We don't generate components here — loot drops that should be refinement
// fragments stamp `kind = 'refinement'` and use the standard item flow.

const PAIRS = Object.freeze({
  // CUO RefinementType pairs: each refinement boost steals from its
  // diametric resist. Standard SA matrix.
  physical: 'energy',
  fire:     'cold',
  cold:     'fire',
  poison:   'physical',
  energy:   'physical',
});

const VALID = new Set(Object.keys(PAIRS));

function ensureResists(item) {
  return (item.resists ??= { physical: 0, fire: 0, cold: 0, poison: 0, energy: 0 });
}

/**
 * Bond a refinement onto an armor piece. Returns true on success.
 *
 * @param {object} item       target armor (must be equippable)
 * @param {string} resist     one of physical/fire/cold/poison/energy
 * @param {number} amount     1..25 inclusive; values out of range are clamped
 */
export function applyRefinement(item, resist, amount) {
  if (!item || !VALID.has(resist)) return false;
  if (item._refinement) return false;  // already refined
  const value = Math.max(1, Math.min(25, amount | 0));
  const r = ensureResists(item);
  r[resist] = (r[resist] | 0) + value;
  const paired = PAIRS[resist];
  r[paired] = (r[paired] | 0) - 1;
  item._refinement = { resist, amount: value, paired };
  return true;
}

/** Reverses applyRefinement's resist deltas. Returns true if a refinement
 *  was actually present. */
export function removeRefinement(item) {
  const cur = item?._refinement;
  if (!cur) return false;
  const r = ensureResists(item);
  r[cur.resist] = (r[cur.resist] | 0) - cur.amount;
  r[cur.paired] = (r[cur.paired] | 0) + 1;
  delete item._refinement;
  return true;
}

export function refinementFor(item) {
  return item?._refinement ?? null;
}

/** Lookup helper for UI — list which resist a given component would buff,
 *  used by the refinement combiner gump tooltip. */
export const REFINEMENT_PAIRS = PAIRS;
