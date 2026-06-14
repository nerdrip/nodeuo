// Skill Masteries — passive bonus items that, when worn or equipped to
// a specific layer, boost a skill above its cap or grant a special
// ability. Mirrors ServUO `Engines/SkillMasteries/`.
//
// Each mastery item declares:
//   • skillId         — the skill that benefits
//   • bonus           — passive points added (e.g. +5 Magery)
//   • activeAbility   — tied special move (Whispering Rose, Toughness…)
//   • prerequisite    — skill must be at cap (100) before bonus applies
//
// API:
//   masteries.applyMastery(mob, item)        — when item is equipped
//   masteries.removeMastery(mob, item)       — when item is unequipped
//   masteries.activeAbility(mob)             — returns the chosen ability
//   masteries.chooseAbility(mob, ability)    — switch the slotted ability
//
// State on the mobile:
//   mob.masteries = { skillBonus: { [skillId]: number }, activeAbility: string|null }

import { addSkillMod, removeSkillModsByOwner } from '../world/skill-mods.js';
import { normalizeSkillValue } from '../combat-formulas.js';

const ABILITY_LIST = Object.freeze([
  // Spellcasting trees
  'arcane-empowerment', 'spellweave-resonance', 'wraith-form-mastery',
  // Combat trees
  'toughness', 'whispering-rose', 'inspire',
  // Bard trees
  'perseverance', 'tribulation', 'despair',
  // Stealth trees
  'death-strike', 'shadow-strike',
  // Tradeskill trees
  'mass-resurrection', 'enchantment-mastery',
]);

// Audit #42 P1 #3 — every skill ID in this table was wrong (off by
// 1-12). Canonical IDs per `apps/scripts/src/data/config/skills.json`:
//   Magery=26, Spellweaving=55, Necromancy=50, Tactics=28,
//   Swordsmanship=41, Musicianship=30, Provocation=23, Ninjitsu=54,
//   Tinkering=38. Was: `abilitiesForSkill()` returned [] for every
//   real skill → master-selection gump empty.
const MASTERY_ABILITIES_BY_SKILL = {
  26: ['arcane-empowerment', 'mass-resurrection'],         // Magery
  55: ['spellweave-resonance'],                             // Spellweaving
  50: ['wraith-form-mastery'],                              // Necromancy
  28: ['toughness'],                                        // Tactics
  41: ['whispering-rose'],                                  // Swordsmanship
  30: ['inspire'],                                          // Musicianship
  23: ['perseverance', 'tribulation', 'despair'],           // Provocation
  54: ['death-strike', 'shadow-strike'],                    // Ninjitsu
  38: ['enchantment-mastery'],                              // Tinkering
};

/**
 * Apply mastery from an item. Item must declare `mastery: { skillId, bonus, ability? }`.
 * Bonus is realized as a SkillMod with ownerKey `mastery:${item.serial}` so
 * unequip cleanly removes it.
 */
export function applyMastery(mob, item) {
  if (!mob || !item?.mastery) return false;
  const { skillId, bonus, ability } = item.mastery;
  if (!skillId) return false;

  // Bonus only applies when the underlying skill is at base cap (100).
  const skills = mob.skills ?? {};
  const base = normalizeSkillValue(skills[skillId] ?? skills[String(skillId)] ?? 0);
  if (base < 100) {
    return false;
  }

  addSkillMod(mob, {
    skillId,
    relative: true,
    value: bonus | 0,
    ownerKey: `mastery:${item.serial}`,
    reason: `mastery item: ${item.name ?? 'unnamed'}`,
  });

  mob.masteries ??= { skillBonus: {}, activeAbility: null };
  mob.masteries.skillBonus[skillId] = (mob.masteries.skillBonus[skillId] | 0) + (bonus | 0);
  if (ability) mob.masteries.activeAbility = ability;
  return true;
}

export function removeMastery(mob, item) {
  if (!mob || !item) return false;
  const removed = removeSkillModsByOwner(mob, `mastery:${item.serial}`);
  const m = item.mastery;
  if (m && mob.masteries?.skillBonus) {
    mob.masteries.skillBonus[m.skillId] = Math.max(
      0, (mob.masteries.skillBonus[m.skillId] | 0) - (m.bonus | 0),
    );
  }
  return removed > 0;
}

export function activeAbility(mob) {
  return mob?.masteries?.activeAbility ?? null;
}

export function chooseAbility(mob, ability) {
  if (!ABILITY_LIST.includes(ability)) return false;
  mob.masteries ??= { skillBonus: {}, activeAbility: null };
  mob.masteries.activeAbility = ability;
  return true;
}

export function abilitiesForSkill(skillId) {
  return MASTERY_ABILITIES_BY_SKILL[skillId] ?? [];
}

// ---- Passive trigger fan-out ----------------------------------------------
//
// ServUO `MasteryInfo.cs` registers a per-mastery `OnHit/OnGotHit/OnCast`
// hook. The hook fires for free when the prerequisite skill is at cap
// AND the matching ability is selected. We provide a single dispatch
// surface that combat-formulas / spell-helpers can call with a kind
// + payload; the dispatcher routes to the right per-mastery body.

const PASSIVE_HOOKS = {
  // Toughness (Tactics): +5 % max HP while equipped. Refreshed
  // implicitly via the skill-mod path; nothing fires per-tick.
  'toughness': null,

  // Whispering Rose (Swordsmanship): 5 % chance per hit to drop the
  // defender into a 4 s daze (paralyzes movement; spell cast OK).
  'whispering-rose': (mob, kind, payload) => {
    if (kind !== 'onHit') return;
    if (Math.random() >= 0.05) return;
    const def = payload?.defender;
    if (!def) return;
    def._dazedUntil = Math.max(def._dazedUntil ?? 0, Date.now() + 4000);
    if (def.client?.sendSystemMessage) {
      def.client.sendSystemMessage('A whispering rose dazes you.');
    }
  },

  // Death Strike (Ninjitsu): every successful hit stacks one death
  // mark on the target; at 5 marks the mark "blooms" — bonus damage
  // on the next move. Stamps `_deathStrikeMarks` on the defender.
  'death-strike': (mob, kind, payload) => {
    if (kind !== 'onHit') return;
    const def = payload?.defender;
    if (!def) return;
    def._deathStrikeMarks = (def._deathStrikeMarks | 0) + 1;
    if (def._deathStrikeMarks >= 5) {
      def._deathStrikeMarks = 0;
      const bonus = 12 + Math.floor(Math.random() * 8);
      def.hp = Math.max(0, (def.hp | 0) - bonus);
      if (def.client?.sendSystemMessage) {
        def.client.sendSystemMessage(`A latent death-strike erupts for ${bonus} damage.`);
      }
    }
  },

  // Inspire (Bard / Music): 5 % chance per nearby ally swing to grant
  // +1 stam regen tick. Cheap and helpful in groups.
  'inspire': (mob, kind, payload) => {
    if (kind !== 'allySwing') return;
    if (Math.random() >= 0.05) return;
    const ally = payload?.ally;
    if (!ally) return;
    ally.stam = Math.min(ally.stamMax ?? 50, (ally.stam | 0) + 1);
  },
};

/**
 * Fire the passive hook for `mob`'s currently-selected mastery, if any.
 * Caller passes a kind ('onHit' | 'onGotHit' | 'onCast' | 'allySwing')
 * plus a payload (defender / spell / ally as appropriate).
 *
 * Cheap fast-path — no allocation when the mob lacks a mastery or the
 * hook doesn't match the kind.
 */
export function firePassive(mob, kind, payload) {
  const ability = mob?.masteries?.activeAbility;
  if (!ability) return;
  const fn = PASSIVE_HOOKS[ability];
  if (!fn) return;
  try { fn(mob, kind, payload); }
  catch (e) { console.error(`[masteries] passive ${ability} threw:`, e); }
}

export const MASTERY_CONST = Object.freeze({
  ABILITY_LIST, MASTERY_ABILITIES_BY_SKILL,
});
