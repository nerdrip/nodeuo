// Spellweaving cumulative mana cost. ServUO `Scripts/Spells/Spellweaving`
// scales each spell's mana by:
//   final = base * (1 + 0.25 * focusBonus + 0.10 * arcaneFocusLevel)
// where `focusBonus` comes from nearby co-casters (Arcane Focus skill)
// and `arcaneFocusLevel` is the temporary buff the caster carries
// after using `ArcaneFocus`. We expose a single helper that the spell
// dispatcher calls before deducting mana.
//
// Cumulative element: each successful Spellweaving cast within a 30-s
// window adds `+1 manaCharge` (capped at 5). The next cast pays
// `manaCharge × 5` extra mana — encourages spacing casts.

// Audit #41 P1 #7 — Spellweaving is skill id 55 (skills.json:56);
// 56 is Mysticism. The mana-cost reader was looking at the wrong
// skill, so the combo penalty never fired off Spellweaving casts.
const SKILL_SPELLWEAVING = 55;
const COMBO_WINDOW_MS = 30_000;
const COMBO_PENALTY_PER_CHARGE = 5;
const COMBO_CAP = 5;

/** Return the (potentially modified) mana cost for a spellweaving cast. */
export function manaCostFor(caster, baseCost) {
  let cost = baseCost | 0;
  // Arcane focus level (set by `ArcaneFocus` spell, ms-gated).
  const af = (caster._arcaneFocusUntil > Date.now()) ? (caster._arcaneFocusLevel ?? 0) : 0;
  if (af > 0) cost = Math.max(0, Math.round(cost * (1 - 0.05 * af)));
  // Combo penalty.
  const combo = (caster._weavingCombo ?? 0);
  cost += combo * COMBO_PENALTY_PER_CHARGE;
  return cost;
}

/** Update the caster's combo charge after a successful cast. */
export function recordSpellweavingCast(caster) {
  const now = Date.now();
  const lastAt = caster._weavingLastAt ?? 0;
  if (now - lastAt > COMBO_WINDOW_MS) caster._weavingCombo = 1;
  else caster._weavingCombo = Math.min(COMBO_CAP, (caster._weavingCombo ?? 0) + 1);
  caster._weavingLastAt = now;
}

/** Apply the temporary Arcane Focus buff. */
export function applyArcaneFocus(caster, level = 1, durationMs = 60_000) {
  caster._arcaneFocusLevel = level;
  caster._arcaneFocusUntil = Date.now() + durationMs;
}

export const SpellweavingSkill = SKILL_SPELLWEAVING;
