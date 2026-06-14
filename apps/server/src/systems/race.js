// Racial system — Human / Elf / Gargoyle. Mirrors ServUO Server/Race.cs
// + Scripts/Misc/RaceDefinitions.cs but slimmed to the per-mobile state
// the rest of the server cares about.
//
// What lives here:
//   • `assignRace(mob, race)` — sets `mob.race`, swaps `mob.body` to the
//     race-canonical (sex-aware) body id, and stamps the racial passive
//     bonuses onto a `mob.racial` bag.
//   • `getRacialBonus(mob, key)` — read the passive bonus for a stat key;
//     skill-gain / regen / cast modifiers consume it.
//   • `applyStoneForm(mob)` — Gargoyle ML ability: +5 phys/fire/poison
//     resists, -10 dex, hue tint 906, can't cast Magery/Necro.
//
// Bodies (CUO Game/Data/Body.cs):
//   Human   male=0x0190 female=0x0191
//   Elf     male=0x025D female=0x025E
//   Gargoyle male=0x029A female=0x029B

import * as statusEffects from '../status-effects.js';

const HUMAN_BODIES    = [0x0190, 0x0191];
const ELF_BODIES      = [0x025D, 0x025E];
const GARGOYLE_BODIES = [0x029A, 0x029B];

const PASSIVES = {
  human: {
    // ToughAsNails — +20 max HP; SkillGainBonus +20%; JackOfAllTrades.
    hpBonus: 20,
    skillGainMul: 1.2,
    jackOfAllTrades: true,
  },
  elf: {
    // NightSight always-on; +20 mana; +5% energy resist; +10 hit-mana-leech.
    nightSight: true,
    manaBonus: 20,
    energyResistBonus: 5,
    manaLeechBonus: 10,
    hue: 0x83EA,                 // base elf hue (paler skin)
  },
  gargoyle: {
    // FlyingAbility (0xBF 0x32); +5% all resist; -20 mana; uses Throwing
    // skill instead of Archery.
    canFly: true,
    allResistBonus: 5,
    manaBonus: -20,
    throwingPreferred: true,
  },
};

/** Set the mobile's race + canonical body id. Idempotent. */
export function assignRace(mob, race) {
  if (!mob || !race) return false;
  const r = String(race).toLowerCase();
  if (!PASSIVES[r]) return false;
  mob.race = r;
  // Apply the passive bonuses bag — overwrites prior ones if race
  // changes mid-character (Race Change Token).
  mob.racial = { ...PASSIVES[r] };
  // Body swap. Pick gender from existing body OR `mob.female` flag.
  const female = mob.female || HUMAN_BODIES[1] === mob.body
              || ELF_BODIES[1] === mob.body || GARGOYLE_BODIES[1] === mob.body;
  if (r === 'human')         mob.body = female ? HUMAN_BODIES[1]    : HUMAN_BODIES[0];
  else if (r === 'elf')      mob.body = female ? ELF_BODIES[1]      : ELF_BODIES[0];
  else if (r === 'gargoyle') mob.body = female ? GARGOYLE_BODIES[1] : GARGOYLE_BODIES[0];
  return true;
}

/** Read a single passive bonus, or 0 if unset. */
export function getRacialBonus(mob, key) {
  if (!mob?.racial) return 0;
  const v = mob.racial[key];
  return typeof v === 'number' ? v : (v ? 1 : 0);
}

/** Toggle Gargoyle Stone Form — adds the `stoneForm` status effect that
 *  the resist / cast pipeline reads. Duration 0 = until manually toggled
 *  off (ServUO uses an indefinite buff with a 5s cooldown).
 *
 *  Returns the new toggle state. */
export function toggleStoneForm(mob) {
  if (!mob) return false;
  if (mob.race !== 'gargoyle') return false;
  if (statusEffects.has(mob, 'stoneForm')) {
    statusEffects.remove(mob, 'stoneForm');
    return false;
  }
  statusEffects.apply(mob, {
    name: 'stoneForm',
    durationMs: 60 * 60_000,
    data: { physBonus: 5, fireBonus: 5, poisonBonus: 5, dexPenalty: -10 },
  });
  return true;
}

/** Look up the canonical body for a (race, female) pair. Used by char
 *  creation when the race is picked at the creator gump. */
export function bodyForRace(race, female = false) {
  switch (String(race ?? '').toLowerCase()) {
    case 'elf':      return female ? ELF_BODIES[1]      : ELF_BODIES[0];
    case 'gargoyle': return female ? GARGOYLE_BODIES[1] : GARGOYLE_BODIES[0];
    default:         return female ? HUMAN_BODIES[1]    : HUMAN_BODIES[0];
  }
}

/** Recover race from a stored body id (used during persistence load). */
export function raceForBody(body) {
  if (HUMAN_BODIES.includes(body))    return 'human';
  if (ELF_BODIES.includes(body))      return 'elf';
  if (GARGOYLE_BODIES.includes(body)) return 'gargoyle';
  return 'human';
}
