// Cartography — skill id 13. Mirrors ServUO `DefCartography.cs`. Maps
// are one of: blank map, regional map, treasure-quality map. Skill
// gates how detailed a map you can produce.

// Audit #43 P1-1 — Cartography is id 13 (skills.json:14). Was 12 (Carpentry).

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 13;

const ITEM = {
  BlankScroll:  0x0E34,    // CUO uses 0x0E34 for blank scrolls; we reuse
                            // for blank maps until we wire dedicated blanks
  CityMap:      0x14EC,    // canonical map item id
  WorldMap:     0x14EE,
  SeaMap:       0x14ED,
  LocalMap:     0x14EB,
  TreasureMap:  0x14EC,
  Sextant:      0x1057,    // tool — must be in pack for higher-tier maps
};

function recipe(id, name, category, minSkill, output, inputs, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 200,
    outputItemId: output, outputCount: opts.outputCount ?? 1,
    toolKind: 'carto',
    inputs: inputs.map(([itemId, count]) => ({ itemId, count })),
    exceptionalChance: 0,
    onCraft: opts.onCraft,
  });
}

// ---- Standard maps -------------------------------------------------------
recipe(12001, 'Local Map',         'Maps',     0,   ITEM.LocalMap,    [[ITEM.BlankScroll, 1]]);
recipe(12002, 'City Map',          'Maps',   200,   ITEM.CityMap,     [[ITEM.BlankScroll, 1]]);
recipe(12003, 'Sea Map',           'Maps',   400,   ITEM.SeaMap,      [[ITEM.BlankScroll, 1]]);
recipe(12004, 'World Map',         'Maps',   600,   ITEM.WorldMap,    [[ITEM.BlankScroll, 2]]);

// Audit #34 P3 #9 — treasure maps. ServUO `DefCartography.cs` enumerates
// 7 difficulty levels (Stash→Trove+Stygian) keyed off cartography skill
// bands. Earlier impl only registered 4 (lvl 1-4) and never stamped the
// `treasureLevel` field, so every spawned map decoded at lvl 1 even when
// the player rolled an "Old Treasure Map" recipe. Now: full 7-level
// table with `onCraft` stamping `treasureLevel` matching the recipe.
recipe(12010, 'Plain Treasure Map','Treasure',300,  ITEM.TreasureMap, [[ITEM.BlankScroll, 1]],
  { onCraft: (it) => { it.treasureLevel = 1; } });
recipe(12011, 'Worn Treasure Map', 'Treasure',500,  ITEM.TreasureMap, [[ITEM.BlankScroll, 1]],
  { onCraft: (it) => { it.treasureLevel = 2; } });
recipe(12012, 'Aged Treasure Map', 'Treasure',700,  ITEM.TreasureMap, [[ITEM.BlankScroll, 1]],
  { onCraft: (it) => { it.treasureLevel = 3; } });
recipe(12013, 'Old Treasure Map',  'Treasure',850,  ITEM.TreasureMap, [[ITEM.BlankScroll, 1]],
  { onCraft: (it) => { it.treasureLevel = 4; } });
recipe(12014, 'Supply Treasure Map','Treasure',950, ITEM.TreasureMap, [[ITEM.BlankScroll, 1]],
  { onCraft: (it) => { it.treasureLevel = 5; } });
recipe(12015, 'Cache Treasure Map','Treasure',1050, ITEM.TreasureMap, [[ITEM.BlankScroll, 1]],
  { onCraft: (it) => { it.treasureLevel = 6; } });
recipe(12016, 'Hoard Treasure Map','Treasure',1150, ITEM.TreasureMap, [[ITEM.BlankScroll, 2]],
  { onCraft: (it) => { it.treasureLevel = 7; } });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/cartography: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/cartography: ' + e.message); } }
  api.log?.('crafting/cartography: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
