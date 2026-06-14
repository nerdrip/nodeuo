export const SKILL_NAMES_BY_ID = Object.freeze({
  1: 'Alchemy',
  2: 'Anatomy',
  3: 'Animal Lore',
  4: 'Item Identification',
  5: 'Arms Lore',
  6: 'Parrying',
  7: 'Begging',
  8: 'Blacksmithy',
  9: 'Bowcraft/Fletching',
  10: 'Peacemaking',
  11: 'Camping',
  12: 'Carpentry',
  13: 'Cartography',
  14: 'Cooking',
  15: 'Detect Hidden',
  16: 'Discordance',
  17: 'Evaluating Intelligence',
  18: 'Healing',
  19: 'Fishing',
  20: 'Forensic Evaluation',
  21: 'Herding',
  22: 'Hiding',
  23: 'Provocation',
  24: 'Inscription',
  25: 'Lockpicking',
  26: 'Magery',
  27: 'Resisting Spells',
  28: 'Tactics',
  29: 'Snooping',
  30: 'Musicianship',
  31: 'Poisoning',
  32: 'Archery',
  33: 'Spirit Speak',
  34: 'Stealing',
  35: 'Tailoring',
  36: 'Animal Taming',
  37: 'Taste Identification',
  38: 'Tinkering',
  39: 'Tracking',
  40: 'Veterinary',
  41: 'Swordsmanship',
  42: 'Mace Fighting',
  43: 'Fencing',
  44: 'Wrestling',
  45: 'Lumberjacking',
  46: 'Mining',
  47: 'Meditation',
  48: 'Stealth',
  49: 'Remove Trap',
  50: 'Necromancy',
  51: 'Focus',
  52: 'Chivalry',
  53: 'Bushido',
  54: 'Ninjitsu',
  55: 'Spellweaving',
  56: 'Mysticism',
  57: 'Imbuing',
  58: 'Throwing',
});

export const SKILL_ACTION_IDS = Object.freeze([
  1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 29, 30, 31, 33, 34, 35, 36, 37, 38, 39, 40, 45,
  46, 47, 48, 49, 57,
]);

const SKILL_ACTION_ID_SET = new Set(SKILL_ACTION_IDS);
const SKILL_ID_BY_KEY = new Map();

function keyOf(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addAlias(id, ...names) {
  for (const name of names) SKILL_ID_BY_KEY.set(keyOf(name), id);
}

for (const [idText, name] of Object.entries(SKILL_NAMES_BY_ID)) {
  const id = Number.parseInt(idText, 10);
  addAlias(id, name);
}

addAlias(2, 'AnatomyMercy');
addAlias(4, 'Item ID', 'ItemID');
addAlias(5, 'ArmsLore');
addAlias(6, 'Parry');
addAlias(8, 'Blacksmith', 'Blacksmithing', 'Smithing');
addAlias(9, 'Bowcraft', 'Fletching', 'Bowcrafting');
addAlias(15, 'Detecting Hidden', 'DetectHidden');
addAlias(17, 'EvalInt', 'Evaluating Intel');
addAlias(20, 'Forensic', 'Forensic Eval');
addAlias(24, 'Inscribe');
addAlias(27, 'Magic Resist', 'MagicResist', 'Resist');
addAlias(37, 'Taste ID', 'TasteID');
addAlias(41, 'Swords');
addAlias(42, 'Macing');
addAlias(45, 'Lumberjack');
addAlias(55, 'SpellWeaving');

export function skillIdFromName(value) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 58) return numeric;
  return SKILL_ID_BY_KEY.get(keyOf(value)) ?? null;
}

export function skillNameFromId(id) {
  const skillId = Number.parseInt(String(id ?? ''), 10);
  return SKILL_NAMES_BY_ID[skillId] ?? `Skill ${skillId}`;
}

export function skillNameFromClientIndex(index) {
  const clientIndex = Number.parseInt(String(index ?? ''), 10);
  return skillNameFromId(clientIndex + 1);
}

export function skillHasAction(skillId) {
  const id = Number.parseInt(String(skillId ?? ''), 10);
  return SKILL_ACTION_ID_SET.has(id);
}

export function skillClientIndexHasAction(index) {
  const clientIndex = Number.parseInt(String(index ?? ''), 10);
  return skillHasAction(clientIndex + 1);
}
