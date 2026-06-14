// Miscellaneous one-shot deeds — Personal Bless, Engraving, Boat
// Naming. ServUO ships these as individual items in `Items/Misc/`
// and `Items/Engraving/`. We register them via the content registry
// so `[items add` can spawn them and the runtime gates them by tag.


// Personal Bless Deed — see `systems/personal-bless.js`. The `[pbd`
// command checks `_isPersonalBlessDeed` flag before consuming.

// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

__PENDING__.push({
  tagId: 'personal-bless-deed',
  kind: 'deed',
  itemId: 0x14F0,
  hue: 0x047E,
  name: 'a personal bless deed',
  weight: 1,
  _isPersonalBlessDeed: true,
});

// Faza F.1.2 — Item Bless Deed (ServUO `Items/Functional/ItemBlessDeed.cs`).
// Single-use deed: targets any item in player's pack, sets `_blessed = true`.
__PENDING__.push({
  tagId: 'item-bless-deed',
  kind: 'deed',
  itemId: 0x14F0,
  hue: 0x0501,
  name: 'an item bless deed',
  weight: 1,
  script: 'item-bless-deed',
});

// Faza F.1.2 — Clothing Bless Deed (ServUO `Items/Functional/ClothingBlessDeed.cs`).
// Only works on clothing layers (shirt/pants/cloak/robe/etc).
__PENDING__.push({
  tagId: 'clothing-bless-deed',
  kind: 'deed',
  itemId: 0x14F0,
  hue: 0x0490,
  name: 'a clothing bless deed',
  weight: 1,
  script: 'clothing-bless-deed',
});

// Faza F.1.2 — Bless Scroll (ServUO `Items/Consumables/BlessScroll.cs`).
// Functionally identical to ItemBlessDeed; different art (scroll vs deed).
__PENDING__.push({
  tagId: 'bless-scroll',
  kind: 'scroll',
  itemId: 0x1F4C,
  hue: 0x0481,
  name: 'a bless scroll',
  weight: 1,
  script: 'bless-scroll',
});

// Engraving Tool (Tinkering-craftable; ServUO `EngravingTool.cs`).
// Player uses this to engrave their items via the `[engrave` command.
// One charge per tool; recharges via Tinkering at cost.
__PENDING__.push({
  tagId: 'engraving-tool',
  kind: 'deed',
  itemId: 0x1EBC,                  // ServUO `EngravingTool` art
  hue: 0x47E,
  name: 'an engraving tool',
  weight: 1,
  engravingTool: { charges: 10 },
});

// Boat Naming Deed — stamps boat.boat.name. Cosmetic only; ServUO
// `BaseBoat.OnDragDropDeed`.
__PENDING__.push({
  tagId: 'boat-naming-deed',
  kind: 'deed',
  itemId: 0x14F0,
  hue: 0x44E,
  name: 'a boat naming deed',
  weight: 1,
  boatNamingDeed: true,
});

// Crimson Dragon Banner — Vesper Museum reward, decorative.
__PENDING__.push({
  tagId: 'crimson-dragon-banner',
  kind: 'decoration',
  itemId: 0x15A7,
  hue: 0x027,                       // crimson
  name: 'crimson dragon banner',
  weight: 5,
  movable: false,
});

// Treasure Hunter Satchel — cartography decoder pouch; +20 % loot
// when looting a treasure chest while wearing it (layer 21 satchel).
__PENDING__.push({
  tagId: 'treasure-hunter-satchel',
  kind: 'container',
  itemId: 0x0E76,
  hue: 0x973,
  layer: 0,
  name: "treasure hunter's satchel",
  weight: 3,
  treasureBonus: 0.20,
});

// Power Hour Scroll — consumable that grants 1 h of accelerated skill
// gain (1.5× chance multiplier on tryGain). ServUO `PowerHourScroll`.
__PENDING__.push({
  tagId: 'power-hour-scroll',
  kind: 'scroll',
  itemId: 0x1F4D,
  hue: 0x021,
  name: 'a power hour scroll',
  weight: 1,
  powerHour: true,
});

// Reagent Bag — auto-draws reagents during cast when present in pack
// or worn. systems/spells/reagents.js inspects worn items for
// `_reagentBag: true` and merges them into the search chain.
__PENDING__.push({
  tagId: 'reagent-bag',
  kind: 'container',
  itemId: 0x0E76,
  hue: 0x55B,
  name: 'a reagent bag',
  weight: 3,
  gumpId: 0x003C,
  _reagentBag: true,
});


// =====================================================================
// Quest reward items — ServUO `Items/Quest/` + `Items/Artifacts/`.
// Catalogue used by the quest-chains JSON rewards (`items:` array).
// Each is a static cosmetic / utility item; functional artifacts that
// need on-equip hooks live in `sa-artifacts.js` / `tokuno-artifacts.js`.
// Adding ~30 most-requested entries to give the audited chains a real
// reward target.
// =====================================================================

const QUEST_ARTIFACTS = [
  // Khaldun Nightmare chain
  { tagId: 'khaldun-talisman',         name: 'a khaldun talisman',         itemId: 0x2F58, hue: 0x047E, weight: 1, kind: 'talisman' },
  { tagId: 'ancient-relic-mask',       name: 'an ancient relic mask',      itemId: 0x1545, hue: 0x047B, weight: 4, kind: 'mask' },
  // Naturalist
  { tagId: 'naturalists-tome',         name: "a naturalist's tome",        itemId: 0x0FBE, hue: 0x059D, weight: 3, kind: 'book' },
  { tagId: 'ranger-cloak',             name: "a ranger's cloak",           itemId: 0x1515, hue: 0x044E, weight: 3, kind: 'cloak' },
  // Bedlam
  { tagId: 'bedlams-pendant',          name: "Bedlam's pendant",           itemId: 0x1F06, hue: 0x0825, weight: 1, kind: 'jewelry' },
  { tagId: 'warden-key',               name: "the warden's key",           itemId: 0x100F, hue: 0x047F, weight: 1, kind: 'key' },
  { tagId: 'mad-mage-tome',            name: "the mad mage's tome",        itemId: 0x0FBF, hue: 0x055A, weight: 5, kind: 'book' },
  // Tomb of Kings
  { tagId: 'royal-signet-ring',        name: 'a royal signet ring',        itemId: 0x108A, hue: 0x0501, weight: 1, kind: 'jewelry' },
  { tagId: 'kings-burial-mask',        name: "the king's burial mask",     itemId: 0x1545, hue: 0x0497, weight: 4, kind: 'mask' },
  { tagId: 'kings-seal',               name: "the king's seal",            itemId: 0x14F0, hue: 0x0500, weight: 1, kind: 'deed' },
  // Underworld
  { tagId: 'experimental-tome',        name: 'an experimental tome',       itemId: 0x0FBF, hue: 0x055B, weight: 4, kind: 'book' },
  { tagId: 'experimental-journal',     name: "an experimental journal",    itemId: 0x0FBE, hue: 0x055C, weight: 1, kind: 'book' },
  { tagId: 'maze-warden-trophy',       name: "the maze warden's trophy",   itemId: 0x1F0F, hue: 0x0481, weight: 8, kind: 'trophy' },
  { tagId: 'spider-queen-fang',        name: "spider queen's fang",        itemId: 0x13F4, hue: 0x0901, weight: 1, kind: 'reagent' },
  { tagId: 'navreys-crown',            name: "Navrey's crown",             itemId: 0x1729, hue: 0x0901, weight: 3, kind: 'helm' },
  { tagId: 'riddle-stone',             name: 'a riddle stone',             itemId: 0x1F19, hue: 0x055D, weight: 1, kind: 'misc' },
  { tagId: 'scholars-medal',           name: "a scholar's medal",          itemId: 0x1F0E, hue: 0x055E, weight: 1, kind: 'misc' },
  // Stygian Abyss chain
  { tagId: 'stygian-dragon-scale',     name: 'a stygian dragon scale',     itemId: 0x26B4, hue: 0x0A85, weight: 5, kind: 'reagent' },
  // Heartwood / ML
  { tagId: 'pixie-swatter',            name: 'a pixie swatter',            itemId: 0x13B4, hue: 0x047E, weight: 6, kind: 'weapon' },
  { tagId: 'acorn-cap-of-the-wood',    name: 'an acorn cap',               itemId: 0x1714, hue: 0x07DA, weight: 2, kind: 'helm' },
  { tagId: 'heartwood-helm',           name: 'a heartwood helm',           itemId: 0x1408, hue: 0x07DA, weight: 5, kind: 'helm' },
  // Charybdis chain
  { tagId: 'charybdis-pearl',          name: 'a charybdis pearl',          itemId: 0x0F7C, hue: 0x0481, weight: 1, kind: 'gem' },
  { tagId: 'explorers-spyglass',       name: "an explorer's spyglass",     itemId: 0x14F5, hue: 0x047C, weight: 2, kind: 'tool', script: 'spyglass' },
  // Mondain (apprentice / curio)
  { tagId: 'midnight-bracers',         name: 'midnight bracers',           itemId: 0x13EE, hue: 0x0461, weight: 5, kind: 'armor' },
  { tagId: 'crystalline-ring',         name: 'a crystalline ring',         itemId: 0x108A, hue: 0x047E, weight: 1, kind: 'jewelry' },
  { tagId: 'mark-of-travesty',         name: 'the mark of travesty',       itemId: 0x1F19, hue: 0x047F, weight: 1, kind: 'misc' },
  // Doom artifacts
  { tagId: 'ring-of-the-vile',         name: 'a ring of the vile',         itemId: 0x108A, hue: 0x0011, weight: 1, kind: 'jewelry' },
  { tagId: 'cloak-of-corruption',      name: 'a cloak of corruption',      itemId: 0x1515, hue: 0x0011, weight: 3, kind: 'cloak' },
  { tagId: 'orc-chieftan-helm',        name: 'an orc chieftain helm',      itemId: 0x1408, hue: 0x0021, weight: 5, kind: 'helm' },
  // Prestige crafting rewards (referenced by tiered quests)
  { tagId: 'miners-prestige-pickaxe',     name: "a miner's prestige pickaxe",     itemId: 0x0E86, hue: 0x047E, weight: 8, kind: 'tool' },
  { tagId: 'lumberjacks-prestige-axe',    name: "a lumberjack's prestige axe",    itemId: 0x0F49, hue: 0x047E, weight: 6, kind: 'tool' },
  { tagId: 'alchemists-prestige-mortar',  name: "an alchemist's prestige mortar", itemId: 0x182A, hue: 0x047E, weight: 4, kind: 'tool' },
  { tagId: 'smiths-prestige-hammer',      name: "a smith's prestige hammer",      itemId: 0x13E3, hue: 0x047E, weight: 8, kind: 'tool' },
  { tagId: 'carpenters-prestige-saw',     name: "a carpenter's prestige saw",     itemId: 0x1034, hue: 0x047E, weight: 4, kind: 'tool' },
  { tagId: 'tailors-prestige-needle',     name: "a tailor's prestige needle",     itemId: 0x0F9D, hue: 0x047E, weight: 1, kind: 'tool' },
  { tagId: 'provisioners-prestige-pack',  name: "a provisioner's prestige pack",  itemId: 0x0E76, hue: 0x047E, weight: 3, kind: 'container' },
];
for (const def of QUEST_ARTIFACTS) {
  __PENDING__.push(def);
}

// =====================================================================
// Quest items batch 2 — ~50 additional ML/SA/Heritage drops referenced
// by region content + boss tables. Each entry is a static cosmetic /
// utility; bigger artifacts with on-equip hooks live in `sa-artifacts`.
// =====================================================================

const QUEST_ARTIFACTS_BATCH_2 = [
  // --- Heartwood / ML extended drops ---
  { tagId: 'arielle-petal',           name: 'an arielle petal',           itemId: 0x1730, hue: 0x07DA, weight: 1, kind: 'reagent' },
  { tagId: 'walker-feather',          name: "walker's feather",           itemId: 0x1BD1, hue: 0x07DA, weight: 1, kind: 'reagent' },
  { tagId: 'wisp-essence',            name: 'wisp essence',               itemId: 0x0F7D, hue: 0x0901, weight: 1, kind: 'reagent' },
  { tagId: 'pixie-dust',              name: 'pixie dust',                 itemId: 0x0F8C, hue: 0x043A, weight: 1, kind: 'reagent' },
  { tagId: 'moondust-shard',          name: 'a moondust shard',           itemId: 0x1F19, hue: 0x047E, weight: 1, kind: 'misc' },
  { tagId: 'cats-tongue',             name: "cat's tongue",               itemId: 0x171E, hue: 0x0481, weight: 1, kind: 'reagent' },

  // --- Solen Hive drops ---
  { tagId: 'red-solen-egg',           name: 'a red solen egg',            itemId: 0x9B5, hue: 0x0021, weight: 1, kind: 'reagent' },
  { tagId: 'black-solen-egg',         name: 'a black solen egg',          itemId: 0x9B5, hue: 0x0001, weight: 1, kind: 'reagent' },
  { tagId: 'solen-queen-pheromone',   name: "solen queen's pheromone",    itemId: 0x0F7D, hue: 0x0042, weight: 1, kind: 'reagent' },
  { tagId: 'hive-honeycomb',          name: 'a hive honeycomb',           itemId: 0x9DF, hue: 0x0044, weight: 2, kind: 'food' },

  // --- Eodon ---
  { tagId: 'tribal-paint',            name: 'tribal paint',               itemId: 0x0E25, hue: 0x0066, weight: 1, kind: 'misc' },
  { tagId: 'tigers-tooth',            name: "a tiger's tooth",            itemId: 0x108B, hue: 0x0481, weight: 1, kind: 'reagent' },
  { tagId: 'jadeite-figurine',        name: 'a jadeite figurine',         itemId: 0x1F0E, hue: 0x043A, weight: 2, kind: 'misc' },
  { tagId: 'gorilla-pelt',            name: 'a gorilla pelt',             itemId: 0x11FB, hue: 0x07DA, weight: 5, kind: 'reagent' },
  { tagId: 'eodon-relic-mask',        name: 'an Eodon relic mask',        itemId: 0x1545, hue: 0x07DA, weight: 4, kind: 'mask' },

  // --- Stygian Abyss extended ---
  { tagId: 'ophidian-scale',          name: 'an ophidian scale',          itemId: 0x26B4, hue: 0x0855, weight: 3, kind: 'reagent' },
  { tagId: 'medusa-scale',            name: "medusa's scale",             itemId: 0x26B4, hue: 0x0901, weight: 3, kind: 'reagent' },
  { tagId: 'gargish-fire-extract',    name: 'gargish fire extract',       itemId: 0x0F7D, hue: 0x0021, weight: 1, kind: 'reagent' },
  { tagId: 'abyssal-cloth',           name: 'abyssal cloth',              itemId: 0x1766, hue: 0x0455, weight: 1, kind: 'cloth' },
  { tagId: 'stygian-fang',            name: 'a stygian fang',             itemId: 0x108B, hue: 0x0A85, weight: 1, kind: 'reagent' },

  // --- Khaldun extended ---
  { tagId: 'khaldun-paragon-fragment',name: 'a paragon fragment',         itemId: 0x1F19, hue: 0x035, weight: 1, kind: 'misc' },
  { tagId: 'sphinx-riddle-scroll',    name: 'a sphinx riddle scroll',     itemId: 0x14F0, hue: 0x055D, weight: 1, kind: 'deed' },
  { tagId: 'lich-soulstone',          name: "lich's soulstone",           itemId: 0x2A93, hue: 0x047B, weight: 1, kind: 'soulstone' },

  // --- Tokuno extended ---
  { tagId: 'sakura-petal',            name: 'a sakura petal',             itemId: 0x1730, hue: 0x0480, weight: 1, kind: 'reagent' },
  { tagId: 'kabuto-of-the-fallen',    name: 'a kabuto of the fallen',     itemId: 0x277A, hue: 0x0021, weight: 5, kind: 'helm' },
  { tagId: 'tokuno-tapestry',         name: 'a tokuno tapestry',          itemId: 0x0E2A, hue: 0x0481, weight: 4, kind: 'decoration' },
  { tagId: 'yamandon-tongue',         name: "yamandon's tongue",          itemId: 0x108B, hue: 0x0901, weight: 2, kind: 'reagent' },
  { tagId: 'fan-of-judgement',        name: 'fan of judgement',           itemId: 0x27A1, hue: 0x0481, weight: 1, kind: 'weapon' },

  // --- Champion / Doom extended ---
  { tagId: 'champion-skull-rikktor',  name: 'skull of Rikktor',           itemId: 0x1AE2, hue: 0x07DA, weight: 1, kind: 'champion-skull' },
  { tagId: 'champion-skull-semidar',  name: 'skull of Semidar',           itemId: 0x1AE2, hue: 0x0021, weight: 1, kind: 'champion-skull' },
  { tagId: 'champion-skull-mephitis', name: 'skull of Mephitis',          itemId: 0x1AE2, hue: 0x0A85, weight: 1, kind: 'champion-skull' },
  { tagId: 'champion-skull-barracoon',name: 'skull of Barracoon',         itemId: 0x1AE2, hue: 0x0066, weight: 1, kind: 'champion-skull' },
  { tagId: 'champion-skull-neira',    name: 'skull of Neira',             itemId: 0x1AE2, hue: 0x0455, weight: 1, kind: 'champion-skull' },
  { tagId: 'champion-skull-serado',   name: 'skull of Serado',            itemId: 0x1AE2, hue: 0x0481, weight: 1, kind: 'champion-skull' },
  { tagId: 'doom-platinum-coin',      name: 'a doom platinum coin',       itemId: 0x0EED, hue: 0x047E, weight: 0, kind: 'currency' },

  // --- Faction & VvV trophies ---
  { tagId: 'minax-banner-fragment',   name: 'a minax banner fragment',    itemId: 0x14F0, hue: 0x0026, weight: 1, kind: 'misc' },
  { tagId: 'truebrit-medal',          name: 'a True Britannian medal',    itemId: 0x1F0E, hue: 0x0481, weight: 1, kind: 'misc' },
  { tagId: 'shadowlord-rune',         name: 'a shadowlord rune',          itemId: 0x1F14, hue: 0x0001, weight: 1, kind: 'misc' },
  { tagId: 'council-seal',            name: "the council's seal",         itemId: 0x14F0, hue: 0x0030, weight: 1, kind: 'misc' },

  // --- Seasonal / event drops ---
  { tagId: 'krampus-coal',            name: 'a piece of krampus coal',    itemId: 0x1869, hue: 0x0001, weight: 1, kind: 'reagent' },
  { tagId: 'krampus-mask',            name: "krampus's mask",             itemId: 0x1545, hue: 0x0021, weight: 4, kind: 'mask' },
  { tagId: 'easter-egg',              name: 'an easter egg',              itemId: 0x9B5, hue: 0x0480, weight: 0, kind: 'food' },
  { tagId: 'pumpkin-soul',            name: 'a soul-bound pumpkin',       itemId: 0x0C6A, hue: 0x002B, weight: 2, kind: 'misc' },
  { tagId: 'naughty-coal',            name: 'a lump of naughty coal',     itemId: 0x1869, hue: 0x0455, weight: 1, kind: 'misc' },

  // --- Naturalist extended ---
  { tagId: 'great-hart-antler',       name: "a great hart's antler",      itemId: 0x108B, hue: 0x07DA, weight: 3, kind: 'reagent' },
  { tagId: 'ancient-wyrm-tooth',      name: "an ancient wyrm's tooth",    itemId: 0x108B, hue: 0x0901, weight: 2, kind: 'reagent' },
  { tagId: 'cu-sidhe-claw',           name: 'a cu sidhe claw',            itemId: 0x108B, hue: 0x047B, weight: 1, kind: 'reagent' },
  { tagId: 'reptalon-egg',            name: 'a reptalon egg',             itemId: 0x9B5, hue: 0x0901, weight: 2, kind: 'reagent' },

  // --- Misc utility / quest currency ---
  { tagId: 'questgiver-token',        name: 'a quest token',              itemId: 0x14F0, hue: 0x0481, weight: 0, kind: 'misc' },
  { tagId: 'guild-stipend-purse',     name: 'a guild stipend purse',      itemId: 0x0E76, hue: 0x047E, weight: 1, kind: 'container' },
];
for (const def of QUEST_ARTIFACTS_BATCH_2) {
  __PENDING__.push(def);
}

// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('deeds-misc: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('deeds-misc: ' + e.message); } }
  api.log?.('deeds-misc: registered ' + count + ' items');
  return () => {};
}