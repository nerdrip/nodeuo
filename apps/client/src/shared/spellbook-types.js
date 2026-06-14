export const SPELLBOOK_TYPE_BY_KIND = Object.freeze({
  spellbook: 0,
  'mage-spellbook': 0,
  'magery-spellbook': 0,
  'necro-spellbook': 1,
  'necromancy-spellbook': 1,
  'paladin-spellbook': 2,
  'chivalry-spellbook': 2,
  'bushido-spellbook': 3,
  'ninja-spellbook': 4,
  'ninjitsu-spellbook': 4,
  'spellweaving-spellbook': 5,
  'mysticism-spellbook': 6,
  'mastery-spellbook': 7,
  'bard-mastery-spellbook': 7,
});

export function spellbookTypeFromKind(kind) {
  const type = SPELLBOOK_TYPE_BY_KIND[String(kind ?? '').toLowerCase()];
  return type == null ? null : type;
}

