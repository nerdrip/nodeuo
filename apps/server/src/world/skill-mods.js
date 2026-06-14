// SkillMod / CapsHolder / SkillScroll — the runtime stacking layer for skill
// values that sits ON TOP of the persistent base values in `mob.skills`.
//
// Why we need this:
//   Base `mob.skills[id]` is the *trained* value (what `tryGain` writes).
//   But active gameplay reads an *effective* value that may be:
//     • higher  (a Bless spell adds +10 to all skills for 30s)
//     • lower   (a Curse spell takes -15 from all skills)
//     • capped  (a soulstone drop temporarily zeroes the skill)
//
// ServUO models this with `SkillMod` instances attached to the mobile.
// Each mod is rel/abs + value + optional ownerKey for dedupe. The effective
// skill is `base + sum(rel) + max(abs)` (abs overrides win highest, then
// add the rel sum).
//
// SkillScroll: a one-shot consumable that bumps the per-skill cap from 100
// → 105/110/115/120 (AOS power-scrolls). Persisted on `mob.skillCaps[id]`.
// `skill-gain.js::skillCapFor` already reads this — we just add the apply
// helper so consumers can `applySkillScroll(mob, skillId, 110)`.

const SKILL_BASE_CAP = 100;
const SKILL_HARD_CAP = 120;

/**
 * @typedef {Object} SkillMod
 * @property {number} skillId
 * @property {boolean} relative      true → adds to base; false → overrides if higher
 * @property {number} value          delta (rel) or replacement (abs)
 * @property {number} [expiresAt]    epoch ms when mod auto-removes; absent = manual
 * @property {string} [ownerKey]     dedupe key — adding a mod with the same key
 *                                    replaces the previous one with that key
 * @property {string} [reason]       free-form ('bless','curse','disguise')
 */

/** Attach a SkillMod to the mobile. Replaces any existing mod with the same ownerKey. */
export function addSkillMod(mob, mod) {
  if (!mob) return;
  if (!mob._skillMods) mob._skillMods = [];
  if (mod.ownerKey) {
    for (let i = mob._skillMods.length - 1; i >= 0; i--) {
      if (mob._skillMods[i].ownerKey === mod.ownerKey) mob._skillMods.splice(i, 1);
    }
  }
  mob._skillMods.push(mod);
}

/** Drop all mods matching `ownerKey`. Returns how many were removed. */
export function removeSkillModsByOwner(mob, ownerKey) {
  if (!mob?._skillMods) return 0;
  let removed = 0;
  for (let i = mob._skillMods.length - 1; i >= 0; i--) {
    if (mob._skillMods[i].ownerKey === ownerKey) { mob._skillMods.splice(i, 1); removed++; }
  }
  return removed;
}

/** Drop all mods on the mobile (e.g. on resurrect / death). */
export function clearSkillMods(mob) {
  if (mob) mob._skillMods = [];
}

/** Auto-remove expired mods. Caller should run this on a tick. */
export function sweepExpiredSkillMods(mob, now = Date.now()) {
  if (!mob?._skillMods?.length) return 0;
  let removed = 0;
  for (let i = mob._skillMods.length - 1; i >= 0; i--) {
    const m = mob._skillMods[i];
    if (m.expiresAt && m.expiresAt <= now) { mob._skillMods.splice(i, 1); removed++; }
  }
  return removed;
}

/**
 * Compute the effective skill value INCLUDING active mods. Mirrors the
 * `combat-formulas.effectiveSkill` API (which only reads base) so callers
 * can swap to `effectiveSkillWithMods` when they want the buffed total.
 *
 * Stack rule (matches ServUO):
 *   1. Pick the highest absolute mod (if any) as the "override" floor.
 *   2. Sum all relative mods.
 *   3. Effective = max(override, base) + relativeSum
 *   4. Clamp to [0, hard cap].
 */
export function effectiveSkillWithMods(mob, skillId, baseGetter) {
  const base = baseGetter ? baseGetter(mob, skillId) : 0;
  if (!mob?._skillMods?.length) return base;
  let absMax = -Infinity;
  let relSum = 0;
  for (const m of mob._skillMods) {
    if (m.skillId !== skillId) continue;
    if (m.relative) relSum += (m.value | 0);
    else if (m.value > absMax) absMax = m.value;
  }
  const floor = absMax === -Infinity ? base : Math.max(base, absMax);
  const eff = floor + relSum;
  return Math.max(0, Math.min(SKILL_HARD_CAP, eff));
}

/**
 * Apply a power-scroll: bump `mob.skillCaps[skillId]` to the new ceiling.
 * Valid ceilings: 105, 110, 115, 120. No-op if the new value isn't strictly
 * higher than the current cap.
 *
 * Returns true if the cap was raised.
 */
export function applySkillScroll(mob, skillId, newCap) {
  if (!mob || !skillId) return false;
  if (newCap !== 105 && newCap !== 110 && newCap !== 115 && newCap !== 120) return false;
  if (!mob.skillCaps) mob.skillCaps = {};
  const cur = mob.skillCaps[skillId] | 0;
  if (newCap <= cur) return false;
  mob.skillCaps[skillId] = newCap;
  return true;
}

/** Apply a stat-scroll: bump `mob.statCap` (default 225, max 250 with +25). */
export function applyStatScroll(mob, increment) {
  if (!mob) return false;
  if (![5, 10, 15, 20, 25].includes(increment | 0)) return false;
  const baseCap = 225;
  const cur = mob.statCap | 0 || baseCap;
  const target = baseCap + (increment | 0);
  if (target <= cur) return false;
  mob.statCap = target;
  return true;
}

/**
 * CapsHolder — per-mobile per-skill cap matrix. ServUO has a Caps[] array
 * indexed by skill id; we use a plain object on the mob (`mob.skillCaps`).
 * Use this helper to centralize reads when a feature wants the cap with
 * scroll bonus baked in.
 */
export function getSkillCap(mob, skillId) {
  const consumed = mob?.skillCaps?.[skillId] | 0;
  if (!consumed) return SKILL_BASE_CAP;
  return Math.min(SKILL_HARD_CAP, consumed);
}

export const SKILL_CAP_CONST = Object.freeze({
  SKILL_BASE_CAP,
  SKILL_HARD_CAP,
});
