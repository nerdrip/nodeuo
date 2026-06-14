// Canonical 1-based skill id -> command line used by 0x12/0x24 UseSkill.
// Keep this in one module so UI/client parity tests can compare against the
// same action surface the network handler actually routes.
export const SKILL_TO_COMMAND = Object.freeze({
  // Crafting.
  1: 'craft gump alchemy',
  8: 'craft gump smithing',
  9: 'craft gump fletching',
  12: 'craft gump carpentry',
  13: 'map',
  14: 'craft gump cooking',
  24: 'craft gump inscription',
  35: 'craft gump tailoring',
  38: 'craft gump tinkering',
  57: 'imbue',

  // Lore / inspect.
  2: 'anatomy',
  3: 'lore',
  4: 'itemid',
  5: 'armslore',
  11: 'camp',
  17: 'evalint',
  20: 'forensic',
  37: 'tasteid',

  // Direct-use action skills.
  7: 'beg',
  15: 'detect',
  18: 'bandage',
  19: 'fish',
  21: 'herd',
  22: 'hide',
  25: 'lockpick',
  29: 'snoop',
  30: 'playinstrument',
  31: 'poison',
  33: 'spiritspeak',
  34: 'steal',
  36: 'tame',
  39: 'track',
  40: 'vet',
  45: 'chop',
  46: 'mine',
  47: 'meditate',
  48: 'stealth',
  49: 'removetrap',

  // Bards.
  10: 'peace',
  16: 'discord',
  23: 'provoke',
});

export const SKILL_ACTION_IDS = Object.freeze(
  Object.keys(SKILL_TO_COMMAND).map((id) => Number.parseInt(id, 10)).sort((a, b) => a - b),
);
