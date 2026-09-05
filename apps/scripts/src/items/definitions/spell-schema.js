const DEFINITIONS = [
  {
    definitionId: 'spell-schema-codex', artId: 0x0FF0,
    name: 'Arcane Schema Codex', hue: 0x0481,
    kind: 'book', category: 'spell-schema', script: 'spell-schema-codex',
    movable: true, weight: 3, newbied: true, blessed: true, accountBound: true,
  },
  {
    definitionId: 'custom-spell-scroll', artId: 0x1F2D,
    name: 'Schema Spell Scroll', hue: 0x0481,
    kind: 'consumable', category: 'custom-spell-scroll', script: 'custom-spell-scroll',
    stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-research-notes', artId: 0x0FF1,
    name: 'Arcane Research Notes', hue: 0x0481,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftXp: 60, stackable: true, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-healing', artId: 0x1F2D,
    name: 'Schema Fragment: Restoration', hue: 0x0048,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:heal', spellcraftXp: 75, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-alteration', artId: 0x1F2D,
    name: 'Schema Fragment: Alteration', hue: 0x0493,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:modifier', spellcraftXp: 100, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-mana', artId: 0x1F2D,
    name: 'Schema Fragment: Mana Channel', hue: 0x0481,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:mana', spellcraftXp: 75, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-stamina', artId: 0x1F2D,
    name: 'Schema Fragment: Vigor Channel', hue: 0x0035,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:stamina', spellcraftXp: 75, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-shield', artId: 0x1F2D,
    name: 'Schema Fragment: Arcane Shield', hue: 0x0482,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:shield', spellcraftXp: 110, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-venom', artId: 0x1F2D,
    name: 'Schema Fragment: Venom', hue: 0x0044,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:poison', spellcraftXp: 110, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-purification', artId: 0x1F2D,
    name: 'Schema Fragment: Purification', hue: 0x0059,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:cleanse', spellcraftXp: 110, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-astral-clock', artId: 0x1F2D,
    name: 'Schema Fragment: Astral Clock', hue: 0x052D,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:time-gate', spellcraftXp: 150, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-fate', artId: 0x1F2D,
    name: 'Schema Fragment: Fate Gate', hue: 0x048D,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'node:chance-gate', spellcraftXp: 150, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-area', artId: 0x1F2D,
    name: 'Schema Fragment: Area Shaping', hue: 0x053B,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'scope:area', spellcraftXp: 100, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-fire', artId: 0x1F2D,
    name: 'Schema Fragment: Fire', hue: 0x0026,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'element:fire', spellcraftXp: 75, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-cold', artId: 0x1F2D,
    name: 'Schema Fragment: Cold', hue: 0x0480,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'element:cold', spellcraftXp: 75, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-poison', artId: 0x1F2D,
    name: 'Schema Fragment: Poison', hue: 0x0044,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'element:poison', spellcraftXp: 100, stackable: false, movable: true, weight: 1,
  },
  {
    definitionId: 'arcane-fragment-energy', artId: 0x1F2D,
    name: 'Schema Fragment: Energy', hue: 0x0482,
    kind: 'consumable', category: 'spellcraft-knowledge', script: 'spellcraft-knowledge',
    spellcraftUnlock: 'element:energy', spellcraftXp: 125, stackable: false, movable: true, weight: 1,
  },
];

export default function register(api) {
  const registerItem = api.catalog?.items?.registerItem;
  if (!registerItem) {
    api.log?.('spell-schema definitions: item catalogue unavailable');
    return () => {};
  }
  for (const definition of DEFINITIONS) registerItem(definition);
  return () => {};
}
