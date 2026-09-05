// Cooking — skill id 14. Mirrors ServUO `Scripts/Services/Craft/DefCooking.cs`.
//
// Most cooking recipes need a heat source (oven / forge / campfire) that
// the script-level cookbook command checks before invoking craft(). The
// ingredient list focuses on raw food → finished goods; baked goods that
// require flour also list the wheat → flour intermediate as a dependency
// the player must produce first.

// Audit #43 P1-1 — Cooking is id 14 (skills.json:15). Was 13 (Cartography).

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 14;
// Recipe ids are globally keyed, not scoped by craft skill. Early cooking
// used the 13xxx range and silently collided with carpentry. Keep the table
// readable while moving its public ids into the skill-aligned 14xxx range.
const RECIPE_ID_OFFSET = 1000;

const ITEM = {
  // Raw ingredients.
  RawRibs:        0x09F1, RawChicken:    0x1607, RawBird: 0x09B9, RawLambLeg: 0x1609,
  RawFishSteak:   0x097A, RawBacon:      0x0976, Wheat:   0x1EBD,
  Flour:          0x1039, Dough:         0x103D,
  Apple:          0x09D0, Eggs:          0x09B5, Milk:    0x09F0, Honey:     0x09EC,
  // Finished items.
  CookedRibs:     0x09F2, CookedChicken: 0x1608, CookedBird: 0x09B7, CookedLambLeg: 0x160A,
  FishSteak:      0x097B, Bacon:         0x0979, Bread:    0x103B, Roll:        0x09EB,
  Cake:           0x09E9, ApplePie:      0x1041, MeatPie:  0x1040, FruitPie:    0x1042,
  Cookies:        0x160B, Pizza:         0x1040, Sausage:  0x09C0,
  // Drinks.
  PitcherWater:   0x1F9D, PitcherMilk:   0x09F0, PitcherAle:    0x099F,
  PitcherWine:    0x09C7, PitcherCider:  0x1F97, PitcherLiquor: 0x099B,
};

function recipe(id, name, category, minSkill, output, inputs, opts = {}) {
  __PENDING__.push({
    id: id + RECIPE_ID_OFFSET, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 200,
    outputItemId: output, outputCount: opts.outputCount ?? 1,
    toolKind: 'cook',
    inputs: inputs.map(([itemId, count]) => ({ itemId, count })),
    exceptionalChance: 0,
  });
}

// ---- Preparation ----------------------------------------------------------
recipe(13001, 'Flour',           'Ingredients',   0,   ITEM.Flour,         [[ITEM.Wheat, 2]]);
recipe(13002, 'Dough',           'Ingredients', 100,   ITEM.Dough,         [[ITEM.Flour, 1], [ITEM.PitcherWater, 1]]);

// ---- Bread / pastries -----------------------------------------------------
recipe(13010, 'Bread',           'Bread',       100,   ITEM.Bread,         [[ITEM.Dough, 1]]);
recipe(13011, 'Rolls',           'Bread',       150,   ITEM.Roll,          [[ITEM.Dough, 1]]);
recipe(13012, 'Cookies',         'Pastries',    250,   ITEM.Cookies,       [[ITEM.Flour, 1], [ITEM.Eggs, 1], [ITEM.Honey, 1]]);
recipe(13013, 'Cake',            'Pastries',    400,   ITEM.Cake,          [[ITEM.Flour, 2], [ITEM.Eggs, 1], [ITEM.Milk, 1]]);
recipe(13014, 'Apple Pie',       'Pies',        300,   ITEM.ApplePie,      [[ITEM.Flour, 1], [ITEM.Apple, 2]]);
recipe(13015, 'Meat Pie',        'Pies',        400,   ITEM.MeatPie,       [[ITEM.Flour, 1], [ITEM.RawRibs, 1]]);
recipe(13016, 'Fruit Pie',       'Pies',        300,   ITEM.FruitPie,      [[ITEM.Flour, 1], [ITEM.Apple, 1]]);

// ---- Cooked meats ---------------------------------------------------------
recipe(13020, 'Cooked Ribs',     'Meat',          0,   ITEM.CookedRibs,    [[ITEM.RawRibs, 1]]);
recipe(13021, 'Cooked Chicken',  'Meat',         50,   ITEM.CookedChicken, [[ITEM.RawChicken, 1]]);
recipe(13022, 'Cooked Bird',     'Meat',         50,   ITEM.CookedBird,    [[ITEM.RawBird, 1]]);
recipe(13023, 'Cooked Lamb',     'Meat',         75,   ITEM.CookedLambLeg, [[ITEM.RawLambLeg, 1]]);
recipe(13024, 'Bacon',           'Meat',         50,   ITEM.Bacon,         [[ITEM.RawBacon, 1]]);
recipe(13025, 'Sausage',         'Meat',        300,   ITEM.Sausage,       [[ITEM.RawRibs, 1], [ITEM.RawBacon, 1]]);
recipe(13026, 'Fish Steak',      'Fish',         50,   ITEM.FishSteak,     [[ITEM.RawFishSteak, 1]]);

// ---- Drinks (jugs/pitchers/bottles) ---------------------------------------
recipe(13030, 'Pitcher of Water', 'Drinks',       0,   ITEM.PitcherWater, [[0x099B, 1]]);
recipe(13031, 'Pitcher of Milk',  'Drinks',       0,   ITEM.PitcherMilk,  [[ITEM.Milk, 1]]);
recipe(13032, 'Pitcher of Ale',   'Drinks',     200,   ITEM.PitcherAle,   [[ITEM.Wheat, 1]]);
recipe(13033, 'Pitcher of Wine',  'Drinks',     250,   ITEM.PitcherWine,  [[ITEM.Apple, 2]]);
recipe(13034, 'Pitcher of Cider', 'Drinks',     150,   ITEM.PitcherCider, [[ITEM.Apple, 3]]);
recipe(13035, 'Pitcher of Liquor','Drinks',     400,   ITEM.PitcherLiquor,[[ITEM.Wheat, 2], [ITEM.Honey, 1]]);

// ---- Tokuno fusion (sushi/onigiri/dango) ----------------------------------
recipe(13040, 'Sushi',           'Tokuno',      400,   0x097B,            [[ITEM.RawFishSteak, 1], [ITEM.Wheat, 1]]);
recipe(13041, 'Sushi Roll',      'Tokuno',      550,   0x097B,            [[ITEM.RawFishSteak, 2], [ITEM.Wheat, 1]]);
recipe(13042, 'Onigiri',         'Tokuno',      300,   0x097B,            [[ITEM.Wheat, 1]]);
recipe(13043, 'Dango',           'Tokuno',      350,   0x160C,            [[ITEM.Flour, 1], [ITEM.Honey, 1]]);

// ---- Banquet / fancy dishes ----------------------------------------------
recipe(13050, 'Quiche',          'Pies',        450,   ITEM.MeatPie,      [[ITEM.Flour, 1], [ITEM.Eggs, 2], [ITEM.Milk, 1]]);
recipe(13051, 'Pumpkin Pie',     'Pies',        400,   ITEM.FruitPie,     [[ITEM.Flour, 1], [0x0C6A, 1]]);
recipe(13052, 'Roast Pig',       'Meat',        700,   ITEM.CookedRibs,   [[ITEM.RawBacon, 4], [ITEM.PitcherWine, 1]]);
recipe(13053, 'Stew',            'Meat',        500,   ITEM.MeatPie,      [[ITEM.RawRibs, 1], [ITEM.PitcherWater, 1], [0x0C77, 1]]);
recipe(13054, 'Pizza',           'Pastries',    600,   ITEM.Pizza,        [[ITEM.Flour, 1], [ITEM.RawBacon, 1], [ITEM.Eggs, 1]]);

// ---- Confectionery -------------------------------------------------------
recipe(13060, 'Cocoa Liquor',    'Confectionery',500,  ITEM.PitcherWater, [[0x103B, 1]]);
recipe(13061, 'Cocoa Butter',    'Confectionery',500,  ITEM.PitcherWater, [[0x103B, 1]]);
recipe(13062, 'Cocoa Powder',    'Confectionery',500,  ITEM.PitcherWater, [[0x103B, 1]]);
recipe(13063, 'Dark Chocolate',  'Confectionery',650,  0x09EA,            [[0x103B, 2], [ITEM.Honey, 1]]);
recipe(13064, 'Milk Chocolate',  'Confectionery',650,  0x09EA,            [[0x103B, 2], [ITEM.Milk, 1]]);
recipe(13065, 'White Chocolate', 'Confectionery',650,  0x09EA,            [[0x103B, 2], [ITEM.Milk, 1], [ITEM.Honey, 1]]);
recipe(13066, 'Honey Cake',      'Confectionery',500,  ITEM.Cake,         [[ITEM.Flour, 1], [ITEM.Honey, 2], [ITEM.Eggs, 1]]);
recipe(13067, 'Caramel',         'Confectionery',300,  ITEM.Cookies,      [[ITEM.Honey, 2], [ITEM.Milk, 1]]);

// ---- Drinks: brewing chains ----------------------------------------------
recipe(13070, 'Mead',            'Drinks',       400,  ITEM.PitcherAle,   [[ITEM.Wheat, 1], [ITEM.Honey, 2]]);
recipe(13071, 'Lemonade',        'Drinks',       100,  ITEM.PitcherWater, [[ITEM.Apple, 2]]);

// ---- Skill-mastery ingredient -- bbq-style food -------------------------
recipe(13080, 'Smoked Meat',     'Meat',         500,  ITEM.CookedRibs,   [[ITEM.RawRibs, 2]]);
recipe(13081, 'Honey Glaze Ham', 'Meat',         600,  ITEM.CookedLambLeg,[[ITEM.RawLambLeg, 1], [ITEM.Honey, 1]]);
recipe(13082, 'Spiced Wine',     'Drinks',       550,  ITEM.PitcherWine,  [[ITEM.Apple, 3], [ITEM.Honey, 1]]);
recipe(13083, 'Fishhead Stew',   'Fish',         400,  ITEM.MeatPie,      [[ITEM.RawFishSteak, 2], [ITEM.PitcherWater, 1]]);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/cooking: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/cooking: ' + e.message); } }
  api.log?.('crafting/cooking: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
