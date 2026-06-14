// Talisman system — wearable trinkets (layer 25, RingBracelet) that grant
// situational bonuses against specific creature kinds, +X to a craft
// skill, or charge-based special abilities. Mirrors ServUO
// `Items/Talismans/BaseTalisman.cs`.
//
// Talisman fields (on item.talisman):
//   slayer:   string                  — creature kind matched for damage bonus (3x)
//   protection: string                — creature kind matched for damage reduction
//   skillBonus: { skillId, bonus }    — passive +X (Cooking +5, Tinkering +5…)
//   craftBonus: { craftKind, bonus }  — % bonus to crafting success rate
//   charges:  { ability, max, used }  — limited-use ability (Mana Phoenix etc)
//   blessed:  boolean                 — survives death
//
// API:
//   talismans.computeSlayerMul(attacker, target)         — 3x if slayer matches kind
//   talismans.computeProtectionMul(victim, attacker)     — 0.5x against matched
//   talismans.useCharge(mob, item)                       — decrement; fizzles if 0
//   talismans.applyEquipBonuses(mob, item)               — when equipped
//   talismans.removeEquipBonuses(mob, item)              — when unequipped

import { addSkillMod, removeSkillModsByOwner } from '../world/skill-mods.js';

/** Damage bonus when attacker's talisman has a matching slayer kind. */
export function computeSlayerMul(attacker, target) {
  const tal = attacker?._equipment?.find?.((p) => p?.talisman?.slayer);
  if (!tal) return 1;
  return tal.talisman.slayer === target?.kind ? 3 : 1;
}

/** Damage reduction when victim's talisman has matching protection. */
export function computeProtectionMul(victim, attacker) {
  const tal = victim?._equipment?.find?.((p) => p?.talisman?.protection);
  if (!tal) return 1;
  return tal.talisman.protection === attacker?.kind ? 0.5 : 1;
}

/**
 * Consume one charge from a charged-ability talisman. Returns true if the
 * ability fired, false if no charges remain.
 */
export function useCharge(item) {
  if (!item?.talisman?.charges) return false;
  const c = item.talisman.charges;
  if ((c.used | 0) >= (c.max | 0)) return false;
  c.used = (c.used | 0) + 1;
  return true;
}

/** Recharge a talisman (e.g. via NPC repair). */
export function recharge(item, charges = null) {
  if (!item?.talisman?.charges) return false;
  const c = item.talisman.charges;
  if (charges == null) c.used = 0;
  else c.used = Math.max(0, c.used - charges);
  return true;
}

/** When equipped, grant the passive bonuses (skill / craft). */
export function applyEquipBonuses(mob, item) {
  const t = item?.talisman;
  if (!mob || !t) return false;
  const ownerKey = `talisman:${item.serial}`;
  if (t.skillBonus) {
    addSkillMod(mob, {
      skillId: t.skillBonus.skillId,
      relative: true,
      value: t.skillBonus.bonus | 0,
      ownerKey,
      reason: `talisman ${item.name ?? ''}`,
    });
  }
  if (t.craftBonus) {
    mob._talismanCraft ??= {};
    mob._talismanCraft[t.craftBonus.craftKind] =
      (mob._talismanCraft[t.craftBonus.craftKind] | 0) + (t.craftBonus.bonus | 0);
  }
  return true;
}

export function removeEquipBonuses(mob, item) {
  if (!mob || !item) return false;
  removeSkillModsByOwner(mob, `talisman:${item.serial}`);
  const t = item?.talisman;
  if (t?.craftBonus && mob._talismanCraft) {
    mob._talismanCraft[t.craftBonus.craftKind] =
      Math.max(0, (mob._talismanCraft[t.craftBonus.craftKind] | 0) - (t.craftBonus.bonus | 0));
  }
  return true;
}

/** Build a talisman item descriptor from a quick spec. */
export function createTalisman(opts = {}) {
  return {
    itemId: opts.itemId ?? 0x2F58,
    name: opts.name ?? 'a talisman',
    layer: 25,
    weight: 1,
    hue: opts.hue ?? 0,
    talisman: {
      slayer: opts.slayer ?? null,
      protection: opts.protection ?? null,
      skillBonus: opts.skillBonus ?? null,
      craftBonus: opts.craftBonus ?? null,
      charges: opts.charges ?? null,
      blessed: !!opts.blessed,
    },
  };
}
