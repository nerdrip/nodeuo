// FAZA EW — Slayer weapons (ServUO `Items/Weapons/SlayerEntries.cs`).
//
// Weapons can carry a `slayer` tag that doubles damage against a
// matching creature kind. Mirrors ServUO's "Silver" (undead),
// "Repond" (humanoid), "Fey" (faerie), "Dragon" etc.
//
// Slayer matrix: weapon.slayer (string) → set of monster kinds it
// triples damage against.

const SLAYER_MATCHUPS = {
  silver:    new Set(['skeleton', 'zombie', 'lich', 'mummy', 'ghoul', 'wraith', 'bone-knight']),
  repond:    new Set(['orc', 'ogre', 'troll', 'lizardman', 'ratman', 'kobold']),
  fey:       new Set(['pixie', 'satyr', 'wisp', 'reaper']),
  dragon:    new Set(['dragon', 'wyrm', 'drake', 'wyvern']),
  daemon:    new Set(['daemon', 'imp', 'gargoyle', 'devourer']),
  arachnid:  new Set(['spider', 'scorpion', 'tarantula']),
  reptile:   new Set(['lizard', 'snake', 'serpent', 'wyvern']),
};

/**
 * Compute the slayer multiplier for the attacker's wielded weapon
 * against the defender's `kind`. Returns 1.0 if no match.
 *
 * @param {{slayer?:string}} weapon
 * @param {{kind?:string}} defender
 */
export function slayerMultiplier(weapon, defender) {
  const tag = weapon?.slayer;
  if (!tag) return 1.0;
  const matchSet = SLAYER_MATCHUPS[tag];
  if (!matchSet) return 1.0;
  if (matchSet.has(defender?.kind)) return 3.0;     // ServUO uses ×3 on matching slayer
  return 1.0;
}

export function listSlayerKinds() { return Object.keys(SLAYER_MATCHUPS); }

export const _SLAYER_MATCHUPS = SLAYER_MATCHUPS;
