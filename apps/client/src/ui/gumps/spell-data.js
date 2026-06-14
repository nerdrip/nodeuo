// Spell catalog. Mirrors ClassicUO `Game/Data/SpellsMagery.cs` and the
// sibling Necromancy/Chivalry/Bushido/Ninjitsu/Spellweaving/Mysticism
// tables, distilled to what the gump needs to render and cast a spell:
//   - spellId (matches server `cast '<name>'` text command)
//   - circle/level (drives offset slot in the book)
//   - name (display + cast string)
//   - reagent list (display only — server does the actual gating)
//
// IDs follow the CUO `SpellsMagery` numbering; offsets are calculated
// from the school base id (matches our 0xBF 0x1B `offset` field):
//   Magery = 1, Necro = 101, Chivalry = 201, Bushido = 401,
//   Ninjitsu = 501, Spellweaving = 601, Mysticism = 678.

export const SPELLBOOK_GUMPS = {
  0xFFB1: { school: 'Magery',       offset: 1,   pageSpells: 8 },
  0xFFB2: { school: 'Necromancy',   offset: 101, pageSpells: 4 },
  0xFFB3: { school: 'Chivalry',     offset: 201, pageSpells: 5 },
  0xFFB4: { school: 'Bushido',      offset: 401, pageSpells: 6 },
  0xFFB5: { school: 'Ninjitsu',     offset: 501, pageSpells: 8 },
  0xFFB6: { school: 'Spellweaving', offset: 601, pageSpells: 8 },
  0xFFB7: { school: 'Mysticism',    offset: 678, pageSpells: 8 },
};

// Magery — circles 1..8, 8 spells each = 64.
export const MAGERY_SPELLS = [
  // C1
  { id: 1,  name: 'Clumsy',          circle: 1, mana: 4,  reagents: 'BP, NS' },
  { id: 2,  name: 'Create Food',     circle: 1, mana: 4,  reagents: 'GA, GI, MR' },
  { id: 3,  name: 'Feeblemind',      circle: 1, mana: 4,  reagents: 'GA, NS' },
  { id: 4,  name: 'Heal',            circle: 1, mana: 4,  reagents: 'GI, SS' },
  { id: 5,  name: 'Magic Arrow',     circle: 1, mana: 4,  reagents: 'BP, NS, SS' },
  { id: 6,  name: 'Night Sight',     circle: 1, mana: 4,  reagents: 'SS, SA' },
  { id: 7,  name: 'Reactive Armor',  circle: 1, mana: 4,  reagents: 'GA, MR, SS' },
  { id: 8,  name: 'Weaken',          circle: 1, mana: 4,  reagents: 'GA, MR' },
  // C2
  { id: 9,  name: 'Agility',         circle: 2, mana: 6,  reagents: 'BM, MR' },
  { id: 10, name: 'Cunning',         circle: 2, mana: 6,  reagents: 'MR, NS' },
  { id: 11, name: 'Cure',            circle: 2, mana: 6,  reagents: 'GA, GI' },
  { id: 12, name: 'Harm',            circle: 2, mana: 6,  reagents: 'NS, SS' },
  { id: 13, name: 'Magic Trap',      circle: 2, mana: 6,  reagents: 'GA, SA, SS' },
  { id: 14, name: 'Magic Untrap',    circle: 2, mana: 6,  reagents: 'BP, SA' },
  { id: 15, name: 'Protection',      circle: 2, mana: 6,  reagents: 'GA, GI, SA' },
  { id: 16, name: 'Strength',        circle: 2, mana: 6,  reagents: 'MR, NS' },
  // C3
  { id: 17, name: 'Bless',           circle: 3, mana: 9,  reagents: 'GA, MR' },
  { id: 18, name: 'Fireball',        circle: 3, mana: 9,  reagents: 'BP' },
  { id: 19, name: 'Magic Lock',      circle: 3, mana: 9,  reagents: 'GA, BP, SA' },
  { id: 20, name: 'Poison',          circle: 3, mana: 9,  reagents: 'NS' },
  { id: 21, name: 'Telekinesis',     circle: 3, mana: 9,  reagents: 'BM, MR' },
  { id: 22, name: 'Teleport',        circle: 3, mana: 9,  reagents: 'BM, MR' },
  { id: 23, name: 'Unlock',          circle: 3, mana: 9,  reagents: 'BM, SA' },
  { id: 24, name: 'Wall of Stone',   circle: 3, mana: 9,  reagents: 'BM, GA' },
  // C4
  { id: 25, name: 'Arch Cure',       circle: 4, mana: 11, reagents: 'GA, GI, MR' },
  { id: 26, name: 'Arch Protection', circle: 4, mana: 11, reagents: 'GA, GI, MR, SA' },
  { id: 27, name: 'Curse',           circle: 4, mana: 11, reagents: 'GA, MR, NS' },
  { id: 28, name: 'Fire Field',      circle: 4, mana: 11, reagents: 'BP, SA, SS' },
  { id: 29, name: 'Greater Heal',    circle: 4, mana: 11, reagents: 'GA, GI, MR, SS' },
  { id: 30, name: 'Lightning',       circle: 4, mana: 11, reagents: 'BP, MR, SS' },
  { id: 31, name: 'Mana Drain',      circle: 4, mana: 11, reagents: 'BM, BP, MR' },
  { id: 32, name: 'Recall',          circle: 4, mana: 11, reagents: 'BM, BP, MR' },
  // C5
  { id: 33, name: 'Blade Spirits',   circle: 5, mana: 14, reagents: 'BP, MR, NS' },
  { id: 34, name: 'Dispel Field',    circle: 5, mana: 14, reagents: 'BP, GA, SA, SS' },
  { id: 35, name: 'Incognito',       circle: 5, mana: 14, reagents: 'BM, GA, NS' },
  { id: 36, name: 'Magic Reflection',circle: 5, mana: 14, reagents: 'GA, MR, SS' },
  { id: 37, name: 'Mind Blast',      circle: 5, mana: 14, reagents: 'BP, MR, NS, SS' },
  { id: 38, name: 'Paralyze',        circle: 5, mana: 14, reagents: 'GA, MR, SS' },
  { id: 39, name: 'Poison Field',    circle: 5, mana: 14, reagents: 'BM, NS, SS' },
  { id: 40, name: 'Summon Creature', circle: 5, mana: 14, reagents: 'BM, MR, SS' },
  // C6
  { id: 41, name: 'Dispel',          circle: 6, mana: 20, reagents: 'GA, SS' },
  { id: 42, name: 'Energy Bolt',     circle: 6, mana: 20, reagents: 'BP, NS' },
  { id: 43, name: 'Explosion',       circle: 6, mana: 20, reagents: 'BP, MR' },
  { id: 44, name: 'Invisibility',    circle: 6, mana: 20, reagents: 'BM, NS' },
  { id: 45, name: 'Mark',            circle: 6, mana: 20, reagents: 'BM, BP, MR' },
  { id: 46, name: 'Mass Curse',      circle: 6, mana: 20, reagents: 'GA, MR, NS, SS' },
  { id: 47, name: 'Paralyze Field',  circle: 6, mana: 20, reagents: 'BM, GA, SS' },
  { id: 48, name: 'Reveal',          circle: 6, mana: 20, reagents: 'BM, SA' },
  // C7
  { id: 49, name: 'Chain Lightning', circle: 7, mana: 30, reagents: 'BP, BM, MR, SS' },
  { id: 50, name: 'Energy Field',    circle: 7, mana: 30, reagents: 'BP, MR, SA, SS' },
  { id: 51, name: 'Flame Strike',    circle: 7, mana: 30, reagents: 'SS, SA' },
  { id: 52, name: 'Gate Travel',     circle: 7, mana: 30, reagents: 'BM, MR, SS' },
  { id: 53, name: 'Mana Vampire',    circle: 7, mana: 30, reagents: 'BM, BP, MR, SS' },
  { id: 54, name: 'Mass Dispel',     circle: 7, mana: 30, reagents: 'BM, BP, GA, SS' },
  { id: 55, name: 'Meteor Swarm',    circle: 7, mana: 30, reagents: 'BM, BP, MR, SS' },
  { id: 56, name: 'Polymorph',       circle: 7, mana: 30, reagents: 'BM, MR, SS' },
  // C8
  { id: 57, name: 'Earthquake',      circle: 8, mana: 40, reagents: 'BM, GI, MR, SS' },
  { id: 58, name: 'Energy Vortex',   circle: 8, mana: 40, reagents: 'BM, BP, MR, NS' },
  { id: 59, name: 'Resurrection',    circle: 8, mana: 40, reagents: 'BM, GI, SS' },
  { id: 60, name: 'Air Elemental',   circle: 8, mana: 40, reagents: 'BM, MR, SS' },
  { id: 61, name: 'Summon Daemon',   circle: 8, mana: 40, reagents: 'BM, MR, SS' },
  { id: 62, name: 'Earth Elemental', circle: 8, mana: 40, reagents: 'BM, MR, SS' },
  { id: 63, name: 'Fire Elemental',  circle: 8, mana: 40, reagents: 'BM, MR, SS, SA' },
  { id: 64, name: 'Water Elemental', circle: 8, mana: 40, reagents: 'BM, MR, SS' },
];

export const NECROMANCY_SPELLS = [
  { id: 101, name: 'Animate Dead',     circle: 1, mana: 23 },
  { id: 102, name: 'Blood Oath',        circle: 1, mana: 13 },
  { id: 103, name: 'Corpse Skin',       circle: 1, mana: 11 },
  { id: 104, name: 'Curse Weapon',      circle: 1, mana:  7 },
  { id: 105, name: 'Evil Omen',         circle: 1, mana: 11 },
  { id: 106, name: 'Horrific Beast',    circle: 1, mana: 11 },
  { id: 107, name: 'Lich Form',         circle: 1, mana: 23 },
  { id: 108, name: 'Mind Rot',          circle: 1, mana: 17 },
  { id: 109, name: 'Pain Spike',        circle: 1, mana:  5 },
  { id: 110, name: 'Poison Strike',     circle: 1, mana: 17 },
  { id: 111, name: 'Strangle',          circle: 1, mana: 29 },
  { id: 112, name: 'Summon Familiar',   circle: 1, mana: 17 },
  { id: 113, name: 'Vampiric Embrace',  circle: 1, mana: 23 },
  { id: 114, name: 'Vengeful Spirit',   circle: 1, mana: 41 },
  { id: 115, name: 'Wither',            circle: 1, mana: 23 },
  { id: 116, name: 'Wraith Form',       circle: 1, mana: 17 },
  { id: 117, name: 'Exorcism',          circle: 1, mana: 40 },
];

export const CHIVALRY_SPELLS = [
  { id: 201, name: 'Cleanse by Fire',   circle: 1, mana: 10 },
  { id: 202, name: 'Close Wounds',      circle: 1, mana: 10 },
  { id: 203, name: 'Consecrate Weapon', circle: 1, mana: 10 },
  { id: 204, name: 'Dispel Evil',       circle: 1, mana: 10 },
  { id: 205, name: 'Divine Fury',       circle: 1, mana: 15 },
  { id: 206, name: 'Enemy of One',      circle: 1, mana: 20 },
  { id: 207, name: 'Holy Light',        circle: 1, mana: 10 },
  { id: 208, name: 'Noble Sacrifice',   circle: 1, mana: 20 },
  { id: 209, name: 'Remove Curse',      circle: 1, mana: 20 },
  { id: 210, name: 'Sacred Journey',    circle: 1, mana: 10 },
];

// Bushido / Ninjitsu / Spellweaving / Mysticism — sparse fallback lists
// so the gump renders something usable. Filled in as we port content.
export const BUSHIDO_SPELLS = [
  { id: 401, name: 'Honorable Execution', circle: 1, mana: 5 },
  { id: 402, name: 'Confidence',          circle: 1, mana: 10 },
  { id: 403, name: 'Evasion',             circle: 1, mana: 10 },
  { id: 404, name: 'Counter Attack',      circle: 1, mana: 5 },
  { id: 405, name: 'Lightning Strike',    circle: 1, mana: 5 },
  { id: 406, name: 'Momentum Strike',     circle: 1, mana: 10 },
];
export const NINJITSU_SPELLS = [
  { id: 501, name: 'Focus Attack',        circle: 1, mana: 5 },
  { id: 502, name: 'Death Strike',        circle: 1, mana: 30 },
  { id: 503, name: 'Animal Form',         circle: 1, mana: 10 },
  { id: 504, name: 'Ki Attack',           circle: 1, mana: 25 },
  { id: 505, name: 'Surprise Attack',     circle: 1, mana: 20 },
  { id: 506, name: 'Backstab',            circle: 1, mana: 30 },
  { id: 507, name: 'Shadowjump',          circle: 1, mana: 15 },
  { id: 508, name: 'Mirror Image',        circle: 1, mana: 10 },
];
export const SPELLWEAVING_SPELLS = [
  { id: 601, name: 'Arcane Circle',       circle: 1, mana: 0 },
  { id: 602, name: 'Gift of Renewal',     circle: 1, mana: 24 },
  { id: 603, name: 'Immolating Weapon',   circle: 1, mana: 32 },
  { id: 604, name: 'Attunement',          circle: 1, mana: 24 },
  { id: 605, name: 'Thunderstorm',        circle: 1, mana: 32 },
  { id: 606, name: 'Nature\'s Fury',      circle: 1, mana: 24 },
];
export const MYSTICISM_SPELLS = [
  { id: 678, name: 'Nether Bolt',         circle: 1, mana: 4 },
  { id: 679, name: 'Healing Stone',       circle: 1, mana: 4 },
  { id: 680, name: 'Purge Magic',         circle: 1, mana: 6 },
  { id: 681, name: 'Enchant',             circle: 1, mana: 6 },
  { id: 682, name: 'Sleep',               circle: 1, mana: 8 },
  { id: 683, name: 'Eagle Strike',        circle: 1, mana: 9 },
  { id: 684, name: 'Animated Weapon',     circle: 1, mana: 11 },
];

const SCHOOLS = {
  0xFFB1: MAGERY_SPELLS,
  0xFFB2: NECROMANCY_SPELLS,
  0xFFB3: CHIVALRY_SPELLS,
  0xFFB4: BUSHIDO_SPELLS,
  0xFFB5: NINJITSU_SPELLS,
  0xFFB6: SPELLWEAVING_SPELLS,
  0xFFB7: MYSTICISM_SPELLS,
};

export function spellsForSchool(gumpId) {
  return SCHOOLS[gumpId & 0xffff] ?? MAGERY_SPELLS;
}

export function spellById(spellId) {
  for (const list of Object.values(SCHOOLS)) {
    const s = list.find((x) => x.id === spellId);
    if (s) return s;
  }
  return null;
}

/** Reverse-lookup by canonical English name (case-insensitive). */
export function spellByName(name) {
  const q = String(name || '').toLowerCase();
  for (const list of Object.values(SCHOOLS)) {
    const s = list.find((x) => x.name.toLowerCase() === q);
    if (s) return s;
  }
  return null;
}

// Per-school icon-graphic base. Mirrors CUO `SpellbookGump.GetBookInfo` —
// every spell's icon is `iconStart + (spellId - schoolFirstId)`. These
// gumppic ids live in gumpartLegacyMUL.uop, drawn at native ~44×44 px.
const ICON_BASES = {
  magery:        { first:   1, base: 0x08C0 },
  necromancy:    { first: 101, base: 0x5000 },
  chivalry:      { first: 201, base: 0x5100 },
  bushido:       { first: 401, base: 0x5400 },
  ninjitsu:      { first: 501, base: 0x5300 },
  spellweaving:  { first: 601, base: 0x59D8 },
  mysticism:     { first: 678, base: 0x5DC0 },
};

// Two-letter codes used in our compact reagent strings → full canonical
// reagent names. Used by the spellbook gump to render the OSI-style
// multi-line "Reagents:" block.
const REAGENT_NAMES = {
  BP: 'Black Pearl',
  BM: 'Bloodmoss',
  GA: 'Garlic',
  GI: 'Ginseng',
  MR: 'Mandrake Root',
  NS: 'Nightshade',
  SS: 'Sulfurous Ash',
  SA: 'Spider\'s Silk',
  // Necromancy reagents
  BS: 'Bat Wing',
  GP: 'Grave Dust',
  DB: 'Daemon Blood',
  NX: 'Nox Crystal',
  PS: 'Pig Iron',
};

/** Expand a reagent code list ("BP, NS, SS") to canonical full names
 *  one per line, OSI spellbook style. */
export function expandReagents(spell) {
  if (!spell?.reagents) return '';
  return spell.reagents
    .split(/[, ]+/).filter(Boolean)
    .map((code) => REAGENT_NAMES[code.toUpperCase()] || code)
    .join('\n');
}

const CIRCLE_NAMES = [
  'First Circle', 'Second Circle', 'Third Circle', 'Fourth Circle',
  'Fifth Circle', 'Sixth Circle', 'Seventh Circle', 'Eighth Circle',
];
export function circleName(n) { return CIRCLE_NAMES[(n | 0) - 1] ?? `Circle ${n}`; }

/** Resolve a spell's gumppic icon id. Returns 0 when out-of-range. */
export function spellIconId(spell) {
  if (!spell) return 0;
  const id = spell.id | 0;
  if (id >= 1   && id <= 64)  return ICON_BASES.magery.base       + (id - ICON_BASES.magery.first);
  if (id >= 101 && id <= 117) return ICON_BASES.necromancy.base   + (id - ICON_BASES.necromancy.first);
  if (id >= 201 && id <= 210) return ICON_BASES.chivalry.base     + (id - ICON_BASES.chivalry.first);
  if (id >= 401 && id <= 410) return ICON_BASES.bushido.base      + (id - ICON_BASES.bushido.first);
  if (id >= 501 && id <= 510) return ICON_BASES.ninjitsu.base     + (id - ICON_BASES.ninjitsu.first);
  if (id >= 601 && id <= 616) return ICON_BASES.spellweaving.base + (id - ICON_BASES.spellweaving.first);
  if (id >= 678 && id <= 692) return ICON_BASES.mysticism.base    + (id - ICON_BASES.mysticism.first);
  return 0;
}
