// LootType — ServUO `LootType` enum. Determines what happens to an item
// on the wearer's death:
//
//   Regular  — fully lootable by the killer / corpse-owner. Default.
//   Newbied  — character receives a copy from the chargen template; on
//              death the item moves to the player's bank box (or stays
//              equipped on res in vendor-equipped flows). Pets dropped
//              by mages at chargen are also Newbied.
//   Blessed  — non-lootable; stays equipped on death. Used for
//              tournament rewards, account-bound items, and per-account
//              storage keys.
//   Cursed   — always drops to the killer regardless of insurance /
//              blessing. AoS / Felucca PvP item-loss mechanic.
//
// Items default to LootType.Regular when the field is missing.
// `containerChildrenRecursive` walkers don't filter by loot type — the
// caller is responsible (see `corpse.js`, `insurance.js`).

export const LootType = Object.freeze({
  Regular: 0,
  Newbied: 1,
  Blessed: 2,
  Cursed:  3,
});

export function lootTypeOf(item) {
  return (item?.lootType | 0) || LootType.Regular;
}

export function isBlessed(item) { return lootTypeOf(item) === LootType.Blessed; }
export function isCursed(item)  { return lootTypeOf(item) === LootType.Cursed; }
export function isNewbied(item) { return lootTypeOf(item) === LootType.Newbied; }

/** Items that should NOT drop to a corpse on death.
 *  Newbied + Blessed stay; Cursed always drops; Regular drops unless
 *  insured. Matches ServUO `BaseCreature.GetLootingRights` semantics. */
export function staysOnDeath(item) {
  const t = lootTypeOf(item);
  return t === LootType.Newbied || t === LootType.Blessed;
}
