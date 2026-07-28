// Character-creation professions, validation rules, and race-specific appearance catalogs.

import { SKILL_NAMES_BY_ID } from '../shared/skill-ids.js';

const ADVANCED_PROFESSION_ID = 0;
const CREATE_SKILL_COUNT = 4;
const CREATE_STAT_TOTAL = 90;
const CREATE_SKILL_TOTALS = new Set([100, 120]);

/** ServUO Professions.cs presets — [str, dex, int, ...skills(id, val)]. */
// Audit rev.4 P2 — profession presets. Curated defaults below are the
// canonical 8 classes; custom shards can ship `assets/professions.json`
// extracted from Prof.txt to override and expand this list. The merge
// happens via `_loadCustomProfessions()` after asset init.
let PROFESSIONS = [
  { id: 1, name: 'Warrior',     desc: 'Anatomy + Healing + Swords + Tactics',
    str: 45, dex: 35, int: 10,
    skills: [{ id: 2, val: 30 }, { id: 18, val: 30 }, { id: 41, val: 30 }, { id: 28, val: 30 }] },
  { id: 2, name: 'Mage',        desc: 'Eval + Wrestling + Magery + Meditation',
    str: 25, dex: 20, int: 45,
    skills: [{ id: 17, val: 30 }, { id: 44, val: 30 }, { id: 26, val: 30 }, { id: 47, val: 30 }] },
  { id: 3, name: 'Blacksmith',  desc: 'Mining + Arms Lore + Smithing + Tinkering',
    str: 60, dex: 15, int: 15,
    skills: [{ id: 46, val: 30 }, { id: 5, val: 30 }, { id: 8, val: 30 }, { id: 38, val: 30 }] },
  { id: 4, name: 'Necromancer', desc: 'Necromancy + Spirit Speak + Swords + Meditation',
    str: 25, dex: 20, int: 45,
    skills: [{ id: 50, val: 30 }, { id: 33, val: 30 }, { id: 41, val: 30 }, { id: 47, val: 30 }] },
  { id: 5, name: 'Paladin',     desc: 'Chivalry + Swords + Focus + Tactics',
    str: 45, dex: 20, int: 25,
    skills: [{ id: 52, val: 30 }, { id: 41, val: 30 }, { id: 51, val: 30 }, { id: 28, val: 30 }] },
  { id: 6, name: 'Samurai',     desc: 'Bushido + Swords + Anatomy + Healing',
    str: 40, dex: 30, int: 20,
    skills: [{ id: 53, val: 30 }, { id: 41, val: 30 }, { id: 2, val: 30 }, { id: 18, val: 30 }] },
  { id: 7, name: 'Ninja',       desc: 'Ninjitsu + Hiding + Fencing + Stealth',
    str: 40, dex: 30, int: 20,
    skills: [{ id: 54, val: 30 }, { id: 22, val: 30 }, { id: 43, val: 30 }, { id: 48, val: 30 }] },
  { id: 0, name: 'Advanced',    desc: 'Pick your own stats and skills',
    str: 60, dex: 15, int: 15,
    skills: [{ id: 41, val: 30 }, { id: 28, val: 30 }, { id: 18, val: 30 }, { id: 26, val: 30 }] },
];

/** Audit rev.4 P2 — merge `assets.professions` (from Prof.txt extractor)
 *  with the curated defaults above. Custom shards can ship extra classes
 *  via the extractor without touching this file. Called lazily from the
 *  Profession-selection page render so the import is cheap. */
function _loadCustomProfessions(assets) {
  const pro = assets?.professions?.byId;
  if (!pro || typeof pro !== 'object') return;
  const customs = [];
  let nextId = Math.max(...PROFESSIONS.map((p) => p.id)) + 1;
  for (const key of Object.keys(pro)) {
    const p = pro[key];
    // Skip categories (they group children, not directly choosable).
    if (p.isCategory) continue;
    // Skip if a curated default already covers this name (case-insensitive).
    if (PROFESSIONS.some((cp) => cp.name.toLowerCase() === key.toLowerCase())) continue;
    let str = 60, dex = 15, int = 15;
    for (const [sid, val] of p.stats ?? []) {
      if (sid === 0) str = val;
      if (sid === 1) dex = val;
      if (sid === 2) int = val;
    }
    const skills = normalizeCreationSkills((p.skills ?? [])
      .slice(0, CREATE_SKILL_COUNT)
      .map(([sid, val]) => ({ id: sid, val })));
    customs.push({
      id: nextId++,
      name: key,
      desc: p.gumpName || `Custom shard profession`,
      str, dex, int, skills,
    });
  }
  if (customs.length) PROFESSIONS = [...PROFESSIONS.slice(0, -1), ...customs, PROFESSIONS[PROFESSIONS.length - 1]];
}

const SKILL_OPTIONS = Object.entries(SKILL_NAMES_BY_ID)
  .map(([id, name]) => [Number.parseInt(id, 10), name])
  .sort((a, b) => a[0] - b[0]);

const DEFAULT_CREATION_SKILLS = Object.freeze([
  { id: 41, val: 30 },
  { id: 28, val: 30 },
  { id: 18, val: 30 },
  { id: 26, val: 30 },
]);

function normalizeCreationSkills(skills = []) {
  const out = [];
  const seen = new Set();
  const push = (skill) => {
    const id = skill?.id | 0;
    if (id < 1 || id > 58 || seen.has(id) || out.length >= CREATE_SKILL_COUNT) return;
    seen.add(id);
    out.push({ id, val: clamp(skill?.val ?? skill?.value ?? 0, 0, 50) });
  };
  for (const skill of skills) push(skill);
  for (const skill of DEFAULT_CREATION_SKILLS) push(skill);
  return out.slice(0, CREATE_SKILL_COUNT);
}

function creationSkillOptionsForRace(race) {
  const isGargoyle = (race | 0) === 2;
  return SKILL_OPTIONS.filter(([id]) => {
    if (id === 48 || id === 49 || id === 55) return false; // Stealth / Remove Trap / Spellweaving
    if (isGargoyle && id === 32) return false;             // Archery
    if (!isGargoyle && id === 58) return false;            // Throwing
    return true;
  });
}

function validateCreationName(name) {
  const value = String(name ?? '');
  if (value !== value.trim()) return 'Name cannot start or end with whitespace.';
  if (value.length < 2 || value.length > 16) return 'Name must be 2-16 characters.';
  let separators = 0;
  let prevSeparator = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const isLetter = /[A-Za-z]/.test(ch);
    const isSeparator = ch === ' ' || ch === '-' || ch === '.' || ch === "'";
    if (!isLetter && !isSeparator) return 'Name can use letters plus one space, dash, period or quote.';
    if (isSeparator) {
      if (i === 0 || i === value.length - 1 || prevSeparator) return 'Name separator must be between letters.';
      separators++;
      if (separators > 1) return 'Name can use only one separator.';
    }
    prevSeparator = isSeparator;
  }
  return '';
}

const HUMAN_SKIN_HUES = [
  { hue: 0x83EA, label: 'Pale' },
  { hue: 0x83EB, label: 'Light' },
  { hue: 0x83F0, label: 'Tan' },
  { hue: 0x83F2, label: 'Olive' },
  { hue: 0x83F5, label: 'Brown' },
  { hue: 0x83F7, label: 'Bronze' },
  { hue: 0x83FA, label: 'Dark' },
  { hue: 0x83FD, label: 'Ebony' },
];

const ELF_SKIN_VALUES = [
  0x4DE, 0x76C, 0x835, 0x430, 0x24D, 0x24E, 0x24F, 0x0BF,
  0x4A7, 0x361, 0x375, 0x367, 0x3E8, 0x3DE, 0x353, 0x903,
  0x76D, 0x384, 0x579, 0x3E9, 0x374, 0x389, 0x385, 0x376,
  0x53F, 0x381, 0x382, 0x383, 0x76B, 0x3E5, 0x51D, 0x3E6,
];

const SKIN_HUES_BY_RACE = [
  HUMAN_SKIN_HUES,
  ELF_SKIN_VALUES.map((h, i) => ({ hue: h | 0x8000, label: `Elf ${i + 1}` })),
  Array.from({ length: 25 }, (_, i) => ({ hue: (1755 + i) | 0x8000, label: `Stone ${i + 1}` })),
];

const CLOTHING_HUES = [
  { hue: 1102, label: 'Black' },
  { hue: 1108, label: 'Dark Brown' },
  { hue: 1144, label: 'Brown' },
  { hue: 1147, label: 'Auburn' },
  { hue: 1148, label: 'Blond' },
  { hue: 1153, label: 'Light Blond' },
  { hue: 1158, label: 'Red' },
  { hue: 1163, label: 'Crimson' },
  { hue: 1175, label: 'Grey' },
  { hue: 1185, label: 'Silver' },
  { hue: 1190, label: 'White' },
];

const HUMAN_HAIR_HUES = CLOTHING_HUES.filter((h) => h.hue >= 1102 && h.hue <= 1149);
const ELF_HAIR_HUE_VALUES = [
  0x034, 0x035, 0x036, 0x037, 0x038, 0x039, 0x058, 0x08E,
  0x08F, 0x090, 0x091, 0x092, 0x101, 0x159, 0x15A, 0x15B,
  0x15C, 0x15D, 0x15E, 0x128, 0x12F, 0x1BD, 0x1E4, 0x1F3,
  0x207, 0x211, 0x239, 0x251, 0x26C, 0x2C3, 0x2C9, 0x31D,
  0x31E, 0x31F, 0x320, 0x321, 0x322, 0x323, 0x324, 0x325,
  0x326, 0x369, 0x386, 0x387, 0x388, 0x389, 0x38A, 0x59D,
  0x6B8, 0x725, 0x853,
];
const GARGOYLE_HAIR_HUE_VALUES = [
  0x709, 0x70B, 0x70D, 0x70F, 0x711, 0x763,
  0x765, 0x768, 0x76B, 0x6F3, 0x6F1, 0x6EF,
  0x6E4, 0x6E2, 0x6E0,
];

const HAIR_HUES_BY_RACE = [
  HUMAN_HAIR_HUES,
  ELF_HAIR_HUE_VALUES.map((h) => ({ hue: h, label: `Hue ${h.toString(16).toUpperCase().padStart(3, '0')}` })),
  GARGOYLE_HAIR_HUE_VALUES.map((h) => ({ hue: h, label: `Horn ${h.toString(16).toUpperCase().padStart(3, '0')}` })),
];

const HUMAN_HAIR_STYLES = [
  { id: 0x0000, label: 'Bald' },
  { id: 0x203B, label: 'Short' },
  { id: 0x203C, label: 'Long' },
  { id: 0x203D, label: 'Pony tail' },
  { id: 0x2044, label: 'Mohawk' },
  { id: 0x2045, label: 'Pageboy' },
  { id: 0x2047, label: 'Afro' },
  { id: 0x2048, label: 'Receding' },
  { id: 0x2049, label: 'Pigtails' },
  { id: 0x204A, label: 'Krisna' },
  { id: 0x2046, label: 'Buns' },
];
const ELF_HAIR_STYLES = [
  { id: 0x0000, label: 'Bald' },
  { id: 0x2FBF, label: 'Mid-long' },
  { id: 0x2FC0, label: 'Long feather' },
  { id: 0x2FC1, label: 'Short' },
  { id: 0x2FC2, label: 'Mullet' },
  { id: 0x2FCC, label: 'Flower' },
  { id: 0x2FCD, label: 'Long' },
  { id: 0x2FCE, label: 'Knob' },
  { id: 0x2FCF, label: 'Braided' },
  { id: 0x2FD0, label: 'Bun' },
  { id: 0x2FD1, label: 'Spiked' },
];
const GARGOYLE_HAIR_STYLES_M = [
  { id: 0x0000, label: 'None' },
  { id: 0x4258, label: 'Plain' },
  { id: 0x4259, label: 'Sweptback' },
  { id: 0x425A, label: 'Long' },
  { id: 0x425B, label: 'Medium' },
  { id: 0x425C, label: 'Bun' },
  { id: 0x425D, label: 'Topknot' },
  { id: 0x425E, label: 'Crowned' },
  { id: 0x425F, label: 'Ridge' },
];
const GARGOYLE_HAIR_STYLES_F = [
  { id: 0x0000, label: 'None' },
  { id: 0x4261, label: 'Short horns' },
  { id: 0x4262, label: 'Long horns' },
  { id: 0x4273, label: 'Curved' },
  { id: 0x4274, label: 'Twisted' },
  { id: 0x4275, label: 'Tall' },
  { id: 0x42B0, label: 'Crown' },
  { id: 0x42B1, label: 'Swept crown' },
  { id: 0x42AA, label: 'Frill' },
  { id: 0x42AB, label: 'Tall frill' },
];
const HUMAN_BEARD_STYLES = [
  { id: 0x0000, label: 'None' },
  { id: 0x203E, label: 'Mustache' },
  { id: 0x203F, label: 'Short beard' },
  { id: 0x2040, label: 'Goatee' },
  { id: 0x2041, label: 'Long beard' },
  { id: 0x204B, label: 'Mustache and beard' },
  { id: 0x204C, label: 'Full beard' },
  { id: 0x204D, label: 'Vandyke' },
];
const GARGOYLE_BEARD_STYLES = [
  { id: 0x0000, label: 'None' },
  { id: 0x42AD, label: 'Jaw horns' },
  { id: 0x42AE, label: 'Hooked jaw' },
  { id: 0x42AF, label: 'Long jaw' },
  { id: 0x42B0, label: 'Crest jaw' },
];

function creationRaceIndex(race) {
  return Math.max(0, Math.min(2, race | 0));
}

function creationSkinHues(race) {
  return SKIN_HUES_BY_RACE[creationRaceIndex(race)] ?? SKIN_HUES_BY_RACE[0];
}

function creationHairHues(race) {
  return HAIR_HUES_BY_RACE[creationRaceIndex(race)] ?? HAIR_HUES_BY_RACE[0];
}

function creationHairStyles(race, sex) {
  const r = creationRaceIndex(race);
  const female = (sex | 0) === 1;
  if (r === 1) {
    return ELF_HAIR_STYLES.filter((s) => {
      if (female) return s.id !== 0x2FBF && s.id !== 0x2FCD;
      return s.id !== 0x2FCC && s.id !== 0x2FD0;
    });
  }
  if (r === 2) return female ? GARGOYLE_HAIR_STYLES_F : GARGOYLE_HAIR_STYLES_M;
  return HUMAN_HAIR_STYLES.filter((s) => {
    if (female) return s.id !== 0x2048;
    return s.id !== 0x2046;
  });
}

function creationBeardStyles(race, sex) {
  if ((sex | 0) === 1) return [{ id: 0, label: 'None' }];
  const r = creationRaceIndex(race);
  if (r === 1) return [{ id: 0, label: 'None' }];
  if (r === 2) return GARGOYLE_BEARD_STYLES;
  return HUMAN_BEARD_STYLES;
}

function normalizeCreationAppearance(c) {
  if (!c) return c;
  c.race = creationRaceIndex(c.race);
  c.sex = c.sex === 1 ? 1 : 0;
  const skin = creationSkinHues(c.race);
  if (!skin.some((h) => h.hue === c.skinHue)) c.skinHue = skin[Math.min(2, skin.length - 1)]?.hue ?? 0x83EA;
  const hairStyles = creationHairStyles(c.race, c.sex);
  if (!hairStyles.some((s) => s.id === c.hairId)) c.hairId = hairStyles[1]?.id ?? hairStyles[0]?.id ?? 0;
  const hairHues = creationHairHues(c.race);
  if (!hairHues.some((h) => h.hue === c.hairHue)) c.hairHue = hairHues[1]?.hue ?? hairHues[0]?.hue ?? 0;
  const beardStyles = creationBeardStyles(c.race, c.sex);
  if (!beardStyles.some((s) => s.id === c.beardId)) c.beardId = 0;
  if (beardStyles.length <= 1) c.beardId = 0;
  c.beardHue = c.hairHue;
  return c;
}

// Max slots displayed in the character picker. ServUO supports 5, 6, or
// 7 depending on the account's `CharacterSlot` flags (see flags 0x80
// SixthCharacterSlot / 0x40 SeventhCharacterSlot in 0xA9 char list).
// 7 covers every modern ServUO config — extra empty slots just render as
// "— Empty Slot —" placeholders which is harmless. The earlier cap of 5
// hid characters at slot index ≥ 5, and clicking a "below the fold"
// character was impossible — _doPlay would always send slot 0..4 and
// ServUO rejected with "Invalid Character Selection" because account[0]
// was actually empty.
const MAX_CHAR_SLOTS = 7;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0));
}

export {
  ADVANCED_PROFESSION_ID, CLOTHING_HUES, CREATE_SKILL_COUNT, CREATE_SKILL_TOTALS, CREATE_STAT_TOTAL,
  ELF_SKIN_VALUES, MAX_CHAR_SLOTS, PROFESSIONS, _loadCustomProfessions, creationBeardStyles, creationHairHues,
  creationHairStyles, creationSkinHues, creationSkillOptionsForRace, normalizeCreationAppearance,
  normalizeCreationSkills, validateCreationName,
};
