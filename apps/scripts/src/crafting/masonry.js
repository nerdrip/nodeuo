// Masonry — secondary crafting skill (id 31, Stonecrafting). Mirrors
// ServUO `DefMasonry.cs`. Players need granite blocks (refined from
// stone via Mining + Stonecrafting talent) to produce paving + stone
// furniture for housing. We focus on the iconic recipes.


// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 31;

const ITEM = {
  Granite:           0x1779, // raw granite block
  // Output art ids — ServUO uses individual class types; we pick canon
  // tile graphics so the items render distinct in containers.
  StoneBlock:        0x0EDC,
  StoneTable:        0x1218,
  StonePaver:        0x1779,
  StoneStatueOfMan:  0x20D2,
  StoneStatueOfWoman:0x20D3,
  StoneAnvil:        0x0FB1,
  StoneCarpetSqr:    0x21FF,
  Gravestone:        0x1170,
  StoneCorridor:     0x0009,
  GargoyleStatue:    0x12CA,
  Ankh:              0x0004,
};

function recipe(id, name, category, minSkill, output, inputs, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 200,
    outputItemId: output, outputCount: opts.outputCount ?? 1,
    inputs: inputs.map(([itemId, count]) => ({ itemId, count })),
    exceptionalChance: opts.exceptionalChance ?? 0.05,
  });
}

// ---- Blocks & paving (low skill) ----------------------------------------
recipe(31001, 'Stone Block',          'Blocks',     0,   ITEM.StoneBlock,         [[ITEM.Granite, 2]]);
recipe(31002, 'Paving Stone',         'Blocks',    50,   ITEM.StonePaver,         [[ITEM.Granite, 1]]);
recipe(31003, 'Granite Slab',         'Blocks',   100,   ITEM.StoneBlock,         [[ITEM.Granite, 4]], { outputCount: 2 });

// ---- Furniture ----------------------------------------------------------
recipe(31010, 'Stone Anvil',          'Furniture', 350, ITEM.StoneAnvil,          [[ITEM.Granite, 6]]);
recipe(31011, 'Stone Table',          'Furniture', 400, ITEM.StoneTable,          [[ITEM.Granite, 8]]);
recipe(31012, 'Stone Carpet (square)','Furniture', 200, ITEM.StoneCarpetSqr,      [[ITEM.Granite, 4]]);
recipe(31013, 'Stone Corridor',       'Furniture', 600, ITEM.StoneCorridor,       [[ITEM.Granite, 12]]);

// ---- Statuary -----------------------------------------------------------
recipe(31020, 'Stone Statue of Man',  'Statuary',  600, ITEM.StoneStatueOfMan,    [[ITEM.Granite, 14]]);
recipe(31021, 'Stone Statue of Woman','Statuary',  600, ITEM.StoneStatueOfWoman,  [[ITEM.Granite, 14]]);
recipe(31022, 'Gargoyle Statue',      'Statuary',  750, ITEM.GargoyleStatue,      [[ITEM.Granite, 18]]);
recipe(31023, 'Ankh',                 'Statuary',  450, ITEM.Ankh,                [[ITEM.Granite, 8]]);
recipe(31024, 'Gravestone',           'Statuary',  300, ITEM.Gravestone,          [[ITEM.Granite, 6]]);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/masonry: engine missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { sys.registerRecipe(def); count++; } catch (e) { api.log?.('crafting/masonry: ' + e.message); } }
  api.log?.('crafting/masonry: registered ' + count + ' recipes');
  return () => {};
}