// Weight system. Mirrors ServUO `Item.PileWeight` + `Mobile.GetTotalWeight`.
//
// Each item exposes:
//   weight       single-unit weight (stones)
//   amount       stack size (gold piles, reagents, etc.)
//
// pileWeight = weight * amount. Container children recurse with weight
// of the container itself counted once.
//
// A mobile's MaxWeight matches ServUO formula:
//   MaxWeight = (Str * 4) + 40
// Past that, players walk slower / can't pick up — enforced by callers.

import { childrenOf, containerChildrenRecursive } from './items.js';
import { staticWeightFor } from './movement.js';

export const BODY_WEIGHT = 14;
export const OVERLOAD_ALLOWANCE = 4;

export function pileWeight(item) {
  if (!item) return 0;
  const w = item._weight != null
    ? Number(item._weight)
    : (item.weight != null ? Number(item.weight) : staticWeightFor(item.itemId | 0));
  const n = Number(item.amount) || 1;
  return Math.max(0, w || 0) * n;
}

/** Sum weight of every item inside `containerSerial` (recursive). */
export function totalContainerWeight(world, containerSerial) {
  let sum = 0;
  for (const it of containerChildrenRecursive(world, containerSerial)) {
    sum += pileWeight(it);
  }
  return sum;
}

/**
 * Sum weight a mobile is carrying — direct equipment + backpack contents.
 * Equipment counts at full weight; the backpack itself is implicit so
 * we don't double-count its container weight.
 */
export function mobileTotalWeight(world, mob) {
  if (!world?.items || !mob) return 0;
  let sum = 0;
  // Runtime worlds maintain a parent -> children reverse index. Status,
  // pickup and every movement step all call this function, so walking the
  // complete item map here turned encumbrance into O(world items) work.
  // `childrenOf` preserves compatibility with direct-map unit fixtures by
  // falling back to the old scan only when no index exists.
  for (const it of childrenOf(world, mob.serial)) {
    sum += pileWeight(it);
    if (it.gumpId) sum += totalContainerWeight(world, it.serial);
  }
  return sum;
}

/** Audit #34 P3 #10 — ServUO `PlayerMobile.MaxWeight`:
 *    `(Human ? 100 : 40) + (int)(3.5 * Str)`
 *  Was `str*4 + 40` for every race — Humans lost the +60 stone racial
 *  bonus, and non-Humans carried ~50 stones more than canon (slope 4
 *  vs 3.5). The Race field has been on the wire since the SE expansion
 *  (we read it as `mob.race` from 0xBF subop 0x19); default to 'human'
 *  when unset so the existing player base doesn't suddenly lose
 *  capacity on the next save round-trip. */
export function maxWeight(mob) {
  const str = Number(mob?.str) || 0;
  const isHuman = !mob?.race || mob.race === 'human' || mob.race === 0 || mob.race === 1;
  const base = isHuman ? 100 : 40;
  return base + Math.floor(3.5 * str);
}

/**
 * Can `mob` pick up an item of `addWeight` stones? Compares post-pickup
 * total vs maxWeight. Pure check — caller is responsible for messaging
 * the user on rejection (cliloc 500153 "That is too heavy.").
 */
export function canCarry(world, mob, addWeight) {
  if (!Number.isFinite(addWeight) || addWeight <= 0) return true;
  return (BODY_WEIGHT + mobileTotalWeight(world, mob) + addWeight)
    <= (maxWeight(mob) + OVERLOAD_ALLOWANCE);
}

/** One authoritative snapshot shared by pickup, status and movement. */
export function encumbrance(world, mob, running = false) {
  const weight = Math.ceil((mob?.bodyWeight ?? BODY_WEIGHT) + mobileTotalWeight(world, mob));
  const capacity = maxWeight(mob);
  const over = Math.max(0, weight - capacity - OVERLOAD_ALLOWANCE);
  const mounted = !!mob?.mountedFrom;
  let staminaCost = 0;
  if (over > 0) {
    staminaCost = 5 + Math.floor(over / 25);
    if (mounted) staminaCost = Math.max(1, Math.floor(staminaCost / 3));
    if (running) staminaCost *= 2;
  }
  // NodeUO's negotiated movement extension makes overload feel like
  // physical burden instead of a stream of reject/snap packets. Classic
  // clients keep ServUO's normal pace and still obey stamina blocking.
  const paceMultiplier = over > 0 ? Math.min(2.5, 1.2 + over / 100) : 1;
  return { weight, capacity, over, overloaded: over > 0, staminaCost, paceMultiplier };
}
