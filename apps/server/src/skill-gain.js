// ServUO-style skill gain. The chance to gain a 0.1-skill point on a use
// peaks where current skill is near the task's difficulty and tapers off
// in both directions:
//   - You can't learn from a task that's far below you (too easy).
//   - You almost never gain from a task that's far above you (too hard).
// And there's a soft total-skills cap (700.0 in OSI) past which only
// active-decay frees room for new gains; we keep the same idea but make
// the cap configurable.
//
// All skill values are stored as plain integers on a 0..120 scale (so
// 50.7 OSI = 50 here). Gains move the value up by 1 with the rolled
// chance — a coarser granularity than OSI's 0.1, but simpler and good
// enough for a Node-port shard.

import { effectiveSkill, normalizeSkillValue } from './combat-formulas.js';

const SKILL_CAP_TOTAL  = 720;     // OSI default 700.0 → we round up
const SKILL_CAP_SINGLE_DEFAULT = 100;  // base ceiling — power-scrolls raise it
const SKILL_CAP_SINGLE_MAX = 120;      // hard limit even with a +20 scroll
const BASE_GAIN_CHANCE = 0.50;    // peak chance at the sweet spot
const gainTelemetry = new Map();
const lastGainAt = new WeakMap();

function gainMetric(skillId) {
  const id = skillId | 0;
  const metric = gainTelemetry.get(id) ?? {
    skillId: id, attempts: 0, gains: 0, capped: 0, totalCapped: 0,
    failedRolls: 0, tooEasyOrHard: 0, anomalies: 0, lastGainAt: 0,
  };
  gainTelemetry.set(id, metric);
  return metric;
}

export function skillGainSnapshot() {
  return [...gainTelemetry.values()].map((entry) => ({ ...entry }));
}

/**
 * Per-skill ceiling for `mob`, honouring power-scroll consumption.
 * `mob.skillCaps?.[skillId]` is the consumed amount (set by the
 * `[powerscroll` admin command and the eventual scroll-use handler).
 * Default = SKILL_CAP_SINGLE_DEFAULT (100); maximum SKILL_CAP_SINGLE_MAX (120).
 */
export function skillCapFor(mob, skillId) {
  const consumed = (mob?.skillCaps?.[skillId] | 0);
  if (!consumed) return SKILL_CAP_SINGLE_DEFAULT;
  return Math.min(SKILL_CAP_SINGLE_MAX, consumed);
}

/**
 * Bell-curve probability that a single use of `skillId` should bump the
 * value by 1. `difficulty` is the perceived task hardness on the same
 * 0..120 scale (e.g. opponent's combat skill, spell's circle midpoint).
 *
 * Curve:
 *   distance = clamp(difficulty - skill, -50, +50)
 *   pct      = max(0, 1 - distance² / 2500)
 *   chance   = BASE_GAIN_CHANCE * pct * (1 - skill/cap)
 *
 * The trailing factor zeroes out at the per-skill cap and gently slows
 * gains as you approach it — matches the late-game grind in OSI without
 * needing a full powerhour/exponential-fall table.
 *
 * `cap` defaults to SKILL_CAP_SINGLE_MAX (120) for backward compat with
 * the original 2-arg signature. Pass the per-mob cap (from skillCapFor)
 * when computing real gain odds — players without a power-scroll only
 * get headroom up to 100, which is what makes power-scrolls meaningful.
 */
export function gainChance(skill, difficulty, cap = SKILL_CAP_SINGLE_MAX) {
  const sk = Math.max(0, skill);
  const diff = Math.max(0, difficulty);
  const ceiling = Math.max(1, cap);
  const distance = Math.max(-50, Math.min(50, diff - sk));
  const pct = Math.max(0, 1 - (distance * distance) / 2500);
  const headroom = Math.max(0, 1 - sk / ceiling);
  return BASE_GAIN_CHANCE * pct * headroom;
}

/**
 * Sum of all numeric skill values on a mob (for the total-skills cap).
 */
function totalSkills(mob) {
  if (!mob?.skills) return 0;
  let sum = 0;
  for (const v of Object.values(mob.skills)) sum += normalizeSkillValue(v);
  return sum;
}

/**
 * Try to award +1 skill on `skillId` after a use against a task of the
 * given `difficulty`. Returns the **new skill value** if a gain
 * happened, or `null` otherwise.
 *
 *   - Returns `null` above the per-skill cap.
 *   - Returns `null` above the total-skills cap (no auto-decay yet —
 *     that's a separate system; for now total cap is hard).
 *   - Optional `rng` lets tests pin the roll.
 *
 * The caller decides whether to surface the gain (system message,
 * 0x3A skill update) — keeping that out of here lets the function
 * stay pure and easy to test.
 *
 * @param {object} mob
 * @param {number} skillId
 * @param {number} difficulty
 * @param {() => number} [rng]
 * @returns {number | null}
 */
export function tryGain(mob, skillId, difficulty, rng = Math.random) {
  const metric = gainMetric(skillId);
  metric.attempts++;
  if (!mob) return null;
  if (typeof rng === 'number') {
    const min = Number(difficulty) || 0;
    const max = Number(rng) || min;
    difficulty = (min + max) / 2;
    rng = Math.random;
  }
  if (!mob.skills) mob.skills = {};
  const cur = effectiveSkill(mob, skillId);
  const cap = skillCapFor(mob, skillId);
  if (cur >= cap) { metric.capped++; return null; }
  // ServUO soft total cap — at the ceiling, attempt to decay a skill
  // marked `lock = 'down'` to make room. Only if no decay-eligible
  // skill exists do we fall through to the hard-cap behaviour.
  if (totalSkills(mob) >= SKILL_CAP_TOTAL) {
    if (!tryDecay(mob, skillId)) { metric.totalCapped++; return null; }
  }
  let chance = gainChance(cur, difficulty, cap);
  // Power Hour — `mob._powerHourUntil` set by consuming a Power Hour
  // scroll. 1.5× gain multiplier while active. ServUO ML-era event,
  // also used by Veteran Rewards (Skill Boost certificate).
  if ((mob._powerHourUntil ?? 0) > Date.now()) {
    chance = Math.min(1, chance * 1.5);
  }
  if (chance <= 0) { metric.tooEasyOrHard++; return null; }
  if (rng() >= chance) { metric.failedRolls++; return null; }
  // Persist on the numeric key — effectiveSkill reads either form, but
  // numeric is the canonical storage shape.
  const next = cur + 1;
  mob.skills[skillId] = next;
  const now = Date.now();
  const previous = lastGainAt.get(mob) ?? 0;
  if (previous && now - previous < 100) metric.anomalies++;
  lastGainAt.set(mob, now);
  metric.gains++;
  metric.lastGainAt = now;
  return next;
}

/**
 * ServUO Skills.cs Atrophy — shave 1 point off any skill the player has
 * flagged `lock = 'down'`. Picks the highest such skill so progress
 * doesn't drain a near-zero skill (otherwise the gainer would always
 * win 1 point at the cost of nothing useful). Returns true when a
 * skill actually decayed; false means no down-locked skill could pay
 * the price (caller refuses the gain to enforce the total cap).
 *
 * Caller passes `excludeSkillId` (the skill currently trying to gain)
 * so we never decay the same skill we're rewarding — ServUO does the
 * same exclusion in its atrophy roll.
 *
 * @param {object} mob
 * @param {number} excludeSkillId
 * @returns {boolean} true if a skill was reduced
 */
export function tryDecay(mob, excludeSkillId) {
  if (!mob?.skills) return false;
  const locks = mob.skillLocks ?? null;
  if (!locks) return false;
  // ServUO `SkillCheck.cs:484 CheckReduceSkill` walks skills in id
  // order and decays the FIRST eligible down-locked skill with a
  // base ≥ the cost of the rewarding skill. Previously we picked the
  // highest-value down-locked skill, which "optimised" the player's
  // build for them — wrong. Walk in numeric id order.
  const ids = Object.keys(mob.skills).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    if (id === excludeSkillId) continue;
    if (locks[id] !== 'down') continue;
    const v = normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
    if (v <= 0) continue;
    mob.skills[id] = Math.max(0, v - 1);
    return true;
  }
  return false;
}

/** Set a skill's lock state. ServUO `Mobile.Skills[id].Lock`. Modifies
 *  `mob.skillLocks` in place. Idempotent. */
export function setSkillLock(mob, skillId, lock) {
  if (!mob) return;
  if (lock !== 'up' && lock !== 'down' && lock !== 'locked') return;
  mob.skillLocks ||= {};
  mob.skillLocks[skillId] = lock;
}

export const SKILL_GAIN_CONST = {
  SKILL_CAP_SINGLE: SKILL_CAP_SINGLE_MAX,         // back-compat alias
  SKILL_CAP_SINGLE_DEFAULT,
  SKILL_CAP_SINGLE_MAX,
  SKILL_CAP_TOTAL,
  BASE_GAIN_CHANCE,
};
