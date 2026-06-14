// Runebook system — ServUO `Items/Books/Runebook.cs` + `RunebookGump.cs`.
// A runebook is a container item that holds up to 16 marked runes (or
// 32 for a Runic Atlas). Players Recall / Sacred Journey / Gate Travel
// from any of the slots; the engine charges per use. Each rune slot
// stores `{ name, x, y, z, map }`.
//
// Browser-side gump support: this module exposes the data layout and
// command-driven verbs. The full client gump can be added later — until
// then the [book command surfaces the same actions.

const RUNEBOOK_SLOTS = 16;
// Audit #33 P2 #8 — ServUO `RunicAtlas.MaxEntries = 48` and max charges
// 100. Was 24 / 30 — players were locked out of half the canonical
// capacity. `[runebook recharge` consumption is fixed in the command
// module to require a Recall/Gate scroll per charge (1/5).
const ATLAS_SLOTS    = 48;
const RUNEBOOK_DEFAULT_CHARGES = 10;
const ATLAS_DEFAULT_CHARGES    = 100;

/**
 * Shape stored on the item:
 *   item.runebook = {
 *     slots: [ {name, x, y, z, map} | null, ... ],
 *     defaultIndex,
 *     chargesLeft, chargesMax,
 *     defaultName,
 *     atlas: bool,
 *   }
 */

/** Initialize a new runebook (or atlas) on an item. */
export function initRunebook(item, opts = {}) {
  const isAtlas = !!opts.atlas;
  item.runebook = {
    slots: Array.from({ length: isAtlas ? ATLAS_SLOTS : RUNEBOOK_SLOTS }, () => null),
    defaultIndex: -1,
    chargesLeft: isAtlas ? ATLAS_DEFAULT_CHARGES : RUNEBOOK_DEFAULT_CHARGES,
    chargesMax:  isAtlas ? ATLAS_DEFAULT_CHARGES : RUNEBOOK_DEFAULT_CHARGES,
    defaultName: opts.name ?? 'a runebook',
    atlas: isAtlas,
  };
  return item.runebook;
}

/** Add or overwrite a slot. Returns the slot index used (-1 on failure). */
export function setSlot(item, index, dest) {
  if (!item?.runebook) return -1;
  if (index < 0 || index >= item.runebook.slots.length) return -1;
  if (!dest || typeof dest.x !== 'number') return -1;
  // BH #11 #13 — sanitize name: strip control chars + clamp 40 chars
  // so save bloat and journal/gump rendering can't be exploited with
  // RTL overrides / 64KB unicode bursts.
  const safeName = String(dest.name ?? `rune ${index + 1}`)
    .replace(/[\x00-\x1F]/g, '')
    .slice(0, 40);
  item.runebook.slots[index] = {
    name: safeName,
    x: dest.x | 0, y: dest.y | 0, z: dest.z | 0, map: dest.map ?? 1,
  };
  return index;
}

/** Inscribe a new rune from a marked rune item — appends to the next
 *  free slot. Returns the index used or -1 if the book is full. */
export function inscribeRune(item, rune) {
  if (!item?.runebook || !rune?.runeDest) return -1;
  const idx = item.runebook.slots.findIndex((s) => s == null);
  if (idx < 0) return -1;
  return setSlot(item, idx, { ...rune.runeDest, name: rune.name ?? `rune ${idx + 1}` });
}

/** Remove a slot (turns it back into nothing — caller may spawn an
 *  empty rune item). */
export function removeSlot(item, index) {
  if (!item?.runebook) return false;
  if (index < 0 || index >= item.runebook.slots.length) return false;
  item.runebook.slots[index] = null;
  if (item.runebook.defaultIndex === index) item.runebook.defaultIndex = -1;
  return true;
}

/** Mark a slot as the default for one-click recall. */
export function setDefault(item, index) {
  if (!item?.runebook) return false;
  if (index < 0 || index >= item.runebook.slots.length) return false;
  if (item.runebook.slots[index] == null) return false;
  item.runebook.defaultIndex = index;
  return true;
}

/** Recall using slot `index`. Returns { ok, dest, reason }. */
export function recall(item, mob, index = -1, mode = 'recall') {
  if (!item?.runebook) return { ok: false, reason: 'no-runebook' };
  if (index < 0) index = item.runebook.defaultIndex;
  if (index < 0) return { ok: false, reason: 'no-default' };
  const dest = item.runebook.slots[index];
  if (!dest) return { ok: false, reason: 'empty-slot' };
  if (item.runebook.chargesLeft <= 0) return { ok: false, reason: 'no-charges' };
  // Audit #35 P1 #3 — ServUO `Runebook.cs:213` always debits a single
  // charge (`--m_Book.CurCharges`) for recall; gate-travel from the
  // gump (`RunebookGump.cs:441 case 4`) bypasses CurCharges entirely
  // because the caster pays the gate spell's own reagents/mana. Was 3
  // for gate, depleting a 100-charge atlas in ~33 gates instead of 100.
  const cost = 1;
  if (item.runebook.chargesLeft < cost) return { ok: false, reason: 'no-charges' };
  item.runebook.chargesLeft -= cost;
  void mode;
  // Caller is responsible for actually moving the mobile + emitting FX.
  return { ok: true, dest };
}

/** Recharge — typically by dropping a recall scroll on the book. */
export function recharge(item, amount = 5) {
  if (!item?.runebook) return 0;
  const before = item.runebook.chargesLeft;
  item.runebook.chargesLeft = Math.min(item.runebook.chargesMax, before + Math.max(1, amount | 0));
  return item.runebook.chargesLeft - before;
}

/** Snapshot for serialization / client gump. */
export function snapshot(item) {
  if (!item?.runebook) return null;
  return {
    slots: item.runebook.slots.map((s) => s ? { ...s } : null),
    defaultIndex: item.runebook.defaultIndex,
    chargesLeft: item.runebook.chargesLeft,
    chargesMax: item.runebook.chargesMax,
    atlas: !!item.runebook.atlas,
    name: item.runebook.defaultName,
  };
}

export const RUNEBOOK_CONST = Object.freeze({
  RUNEBOOK_SLOTS, ATLAS_SLOTS,
  RUNEBOOK_DEFAULT_CHARGES, ATLAS_DEFAULT_CHARGES,
});
