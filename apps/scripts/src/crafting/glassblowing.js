// Glassblowing — secondary craft branch of Alchemy. ServUO
// `DefGlassblowing.cs` keys recipes off `Skill.Alchemy` (skill id 1)
// because there's no separate Glassblowing skill in the OSI table.
// Recipes need sand (raised from beach tiles via `[mine` on a beach
// tile or bought from glassblower vendors) + a Glass Blower's Pipe.


// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 1;                  // Alchemy (ServUO parity)

const ITEM = {
  Sand:           0x11EA,    // raw sand pile
  GlassBlowerPipe:0x182D,    // tool, must be in pack
  ClearVase:      0x0B46,
  EmptyBottle:    0x0F0E,
  HourglassUnused:0x1809,
  HourglassFull:  0x180A,
  EmptyDecanter:  0x182E,
  GlassPitcher:   0x1F9C,
  CrystalSphere:  0x231A,
  Spyglass:       0x14F5,
};

function recipe(id, name, category, minSkill, output, inputs, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 200,
    outputItemId: output, outputCount: opts.outputCount ?? 1,
    toolKind: 'glassblowing',
    inputs: inputs.map(([itemId, count]) => ({ itemId, count })),
    exceptionalChance: opts.exceptionalChance ?? 0.04,
    requiresRecipe: 'glassblowing',
  });
}

// ---- Glassware (low skill) ----------------------------------------------
recipe(51001, 'Empty Bottle',     'Glassware',   0,   ITEM.EmptyBottle,    [[ITEM.Sand, 1]]);
recipe(51002, 'Empty Decanter',   'Glassware',  50,   ITEM.EmptyDecanter,  [[ITEM.Sand, 2]]);
recipe(51003, 'Glass Pitcher',    'Glassware', 150,   ITEM.GlassPitcher,   [[ITEM.Sand, 3]]);
recipe(51004, 'Clear Vase',       'Glassware', 250,   ITEM.ClearVase,      [[ITEM.Sand, 4]]);

// ---- Hourglasses + spyglass --------------------------------------------
recipe(51010, 'Hourglass',        'Tools',     400,   ITEM.HourglassUnused,[[ITEM.Sand, 6]]);
recipe(51011, 'Hourglass (full)', 'Tools',     500,   ITEM.HourglassFull,  [[ITEM.Sand, 6]]);
recipe(51012, 'Spyglass',         'Tools',     650,   ITEM.Spyglass,       [[ITEM.Sand, 4]]);

// ---- Crystal sphere (high) ---------------------------------------------
recipe(51020, 'Crystal Sphere',   'Mystic',    900,   ITEM.CrystalSphere,  [[ITEM.Sand, 12]]);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/glassblowing: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/glassblowing: ' + e.message); } }
  api.log?.('crafting/glassblowing: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
