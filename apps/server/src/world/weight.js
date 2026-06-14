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

import { containerChildrenRecursive } from './items.js';

export function pileWeight(item) {
  if (!item) return 0;
  const w = Number(item.weight) || 0;
  const n = Number(item.amount) || 1;
  return w * n;
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
  for (const it of world.items.values()) {
    if (it.parent !== mob.serial) continue;
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
  return (mobileTotalWeight(world, mob) + addWeight) <= maxWeight(mob);
}
