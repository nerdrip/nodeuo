// Monster Stealing — port of ServUO `Scripts/Services/Monster Stealing/`.
// Uses the `[steal` skill flow but targets a high-level monster's loot
// pack BEFORE the kill, gambling that the player can yank an item
// without aggroing the whole pack. Mirrors ServUO `MonsterStealing.cs`.
//
// Mechanic:
//   - Target must be alive, hostile, and tagged `_stealableLoot=true`
//     (set by spawner for paragons / champ minions / mini-bosses)
//   - Skill check: Stealing vs (creature.fame / 100), capped 5..95%
//   - Fail by ≤25% → noticed, creature aggros, no loot
//   - Fail by >25% → caught flagged criminal even out of guard
//   - Success → roll a random unique from creature._stealablePool[]
//     (server populates this from loot generation), drop into pack.
//
// Stealable items respawn on the creature 30s after a steal so a single
// player can't farm a paragon dry; ServUO uses 60s, but our spawn cadence
// is faster.

import { effectiveSkill } from '../combat-formulas.js';

const COOLDOWN_MS = 30_000;
const SKILL_STEALING = 34;

export function canSteal(mob, target) {
  if (!mob || !target) return false;
  if (target.hp == null || target.hp <= 0) return false;
  if (!target._stealableLoot) return false;
  if (Array.isArray(target._stealablePool) && target._stealablePool.length === 0) return false;
  return true;
}

/**
 * Attempt a monster-stealing roll. `api` is the script API surface so we
 * can mint a real item via `api.items.createItem` + drop into pack.
 * Returns `{ ok, item, criminal, aggro, reason }`.
 */
export function tryMonsterSteal(api, mob, target) {
  if (!canSteal(mob, target)) {
    return { ok: false, reason: 'No stealable loot on that creature.' };
  }
  // Per-creature cooldown — keeps a single player from spamming the
  // same paragon. Stored on the creature object so persistence carries.
  const now = Date.now();
  if (target._stealNextAt && now < target._stealNextAt) {
    return { ok: false, reason: 'You cannot steal again so soon.' };
  }

  const skill = effectiveSkill(mob, SKILL_STEALING);
  const fame  = target.fame ?? 5000;
  const target_required = Math.min(95, Math.max(5, fame / 100));
  const margin = skill - target_required;
  const rolled = Math.random() * 100;
  const success = rolled <= skill;

  target._stealNextAt = now + COOLDOWN_MS;

  if (!success) {
    const aggro = true;
    const criminal = margin < -25;
    return { ok: false, aggro, criminal, reason: 'Caught — they noticed!' };
  }

  // Pick + dispense.
  const pool = target._stealablePool ?? [];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (!pick) return { ok: false, reason: 'Their pouch is empty.' };
  const pack = mob.backpack ?? mob.equipment?.get?.(21);
  const item = api?.items?.createItem?.(api?.world, {
    itemId: pick.itemId | 0,
    name:   pick.name ?? 'stolen item',
    hue:    pick.hue ?? 0,
    amount: 1,
    servuoClass: pick.servuoClass ?? 'StealableInstance',
    servuoClasses: pick.servuoClasses ?? ['StealableInstance', 'StealableEntry', 'StealableArtifactsSpawner'],
    parent: pack?.serial,
    x: 0, y: 0, z: 0, map: 0, gridX: 30, gridY: 30,
  });
  // Remove the picked entry so each unique-item drops only once per
  // refill window.
  target._stealablePool = pool.filter((p) => p !== pick);

  return { ok: true, item };
}
