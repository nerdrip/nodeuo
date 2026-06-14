// UO body / race body IDs. Drawn from CUO `Game/Data/Bodies.cs` +
// ServUO `Server/Race.cs`. The numeric ids show up across packets,
// renderer state, persistence, AI templates — centralising them stops
// the "is this 0x190 or 400?" lookup tax in code review.
//
// SHARED MODULE: pure data, no runtime imports.

// --- Human (race id 0) -----------------------------------------------------
export const BODY_HUMAN_MALE   = 0x0190;   // 400
export const BODY_HUMAN_FEMALE = 0x0191;   // 401

// --- Elf (race id 1) -------------------------------------------------------
export const BODY_ELF_MALE     = 0x025D;
export const BODY_ELF_FEMALE   = 0x025E;

// --- Gargoyle (race id 2) --------------------------------------------------
export const BODY_GARGOYLE_MALE   = 0x029A;
export const BODY_GARGOYLE_FEMALE = 0x029B;

/** Every "human-shaped" body the paperdoll / outfit applier supports.
 *  Spawners pickHumanoidPreset gates on this set — bodies outside it
 *  skip the outfit pass (you can't put a robe on a dragon). */
export const HUMANOID_BODIES = Object.freeze(new Set([
  BODY_HUMAN_MALE, BODY_HUMAN_FEMALE,
  BODY_ELF_MALE,   BODY_ELF_FEMALE,
  BODY_GARGOYLE_MALE, BODY_GARGOYLE_FEMALE,
]));

/** Bodies the death system renders as "ghost form" — pure visual,
 *  separate from `hp <= 0` and the `ghost` flag. Mirrors CUO's
 *  GhostAnimations.cs set. */
export const DEAD_BODIES = Object.freeze(new Set([
  0x0192, 0x0193,         // human male/female ghost
  0x025F, 0x0260,         // elf male/female ghost
  0x02B6, 0x02B7,         // gargoyle male/female ghost
]));

/** Race string for a body id, or `null` if not a humanoid. Server-side
 *  systems (race-change spell, persistence, AI) use this for the
 *  inverse of pickBodyByRace. */
export function raceForBody(body) {
  const b = body | 0;
  if (b === BODY_HUMAN_MALE    || b === BODY_HUMAN_FEMALE)    return 'human';
  if (b === BODY_ELF_MALE      || b === BODY_ELF_FEMALE)      return 'elf';
  if (b === BODY_GARGOYLE_MALE || b === BODY_GARGOYLE_FEMALE) return 'gargoyle';
  return null;
}

/** Pick a body id for (race, female) tuple. Race-change spell + the
 *  character creation flow both go through this so the swap is
 *  consistent across surfaces. Unknown race falls back to human. */
export function bodyForRace(race, female = false) {
  switch ((race ?? 'human').toLowerCase()) {
    case 'elf':      return female ? BODY_ELF_FEMALE      : BODY_ELF_MALE;
    case 'gargoyle': return female ? BODY_GARGOYLE_FEMALE : BODY_GARGOYLE_MALE;
    case 'human':
    default:         return female ? BODY_HUMAN_FEMALE    : BODY_HUMAN_MALE;
  }
}

/** Truth-test for the body being one of the dead-form variants. */
export function isDeadBody(body) {
  return DEAD_BODIES.has(body | 0);
}

/** Truth-test for the body being a humanoid (eligible for paperdoll /
 *  outfit / hair / beard / equipment overlays). */
export function isHumanoidBody(body) {
  return HUMANOID_BODIES.has(body | 0);
}
