// Alchemy — skill id 1. Produces potions + kegs. ServUO reference:
// Scripts/Services/Craft/DefAlchemy.cs. Reagents map to UO art ids:
//   Black Pearl 0x0F7A, Bloodmoss 0x0F7B, Garlic 0x0F84, Ginseng 0x0F85,
//   Mandrake Root 0x0F86, Nightshade 0x0F88, Spiders' Silk 0x0F8D,
//   Sulfurous Ash 0x0F8C.

// Audit #43 P1-1 — Alchemy is id 1 (skills.json:2). Was 2 (Anatomy) →
// every alchemy recipe was misregistered under Anatomy; `[craft list
// alchemy` returned nothing.

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 1;
const EMPTY_BOTTLE = 0x0F0E;

const REAG = {
  BlackPearl: 0x0F7A, Bloodmoss: 0x0F7B, Garlic: 0x0F84, Ginseng: 0x0F85,
  MandrakeRoot: 0x0F86, Nightshade: 0x0F88, SpidersSilk: 0x0F8D, SulfurousAsh: 0x0F8C,
};

function potion(id, name, category, minSkill, outputItemId, reagents, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 200,
    outputItemId, outputCount: 1,
    toolKind: 'alchemy',
    // Potions always consume 1 bottle + the named reagents.
    inputs: [{ itemId: EMPTY_BOTTLE, count: 1 }, ...reagents.map((r) => ({ itemId: r[0], count: r[1] }))],
    exceptionalChance: 0, // classic UO has no exceptional potions
  });
}

// ---- Refresh potions (stam restore) ----------------------------------
potion(2001, 'Refresh Potion',        'Refresh', 0,   0x0F0B, [[REAG.BlackPearl, 1]]);
potion(2002, 'Total Refresh Potion',  'Refresh', 250, 0x0F0B, [[REAG.BlackPearl, 5]]);

// ---- Heal potions ----------------------------------------------------
potion(2010, 'Lesser Heal Potion',    'Healing', 0,   0x0F0C, [[REAG.Ginseng, 1]]);
potion(2011, 'Heal Potion',           'Healing', 150, 0x0F0C, [[REAG.Ginseng, 3]]);
potion(2012, 'Greater Heal Potion',   'Healing', 550, 0x0F0C, [[REAG.Ginseng, 7]]);

// ---- Cure potions ----------------------------------------------------
potion(2020, 'Lesser Cure Potion',    'Cure',    0,   0x0F07, [[REAG.Garlic, 1]]);
potion(2021, 'Cure Potion',           'Cure',    150, 0x0F07, [[REAG.Garlic, 3]]);
potion(2022, 'Greater Cure Potion',   'Cure',    450, 0x0F07, [[REAG.Garlic, 6]]);

// ---- Agility / Strength / Nightsight --------------------------------
potion(2030, 'Agility Potion',        'Buff',    200, 0x0F08, [[REAG.Bloodmoss, 1]]);
potion(2031, 'Greater Agility Potion','Buff',    350, 0x0F08, [[REAG.Bloodmoss, 3]]);
potion(2032, 'Strength Potion',       'Buff',    250, 0x0F09, [[REAG.MandrakeRoot, 2]]);
potion(2033, 'Greater Strength Potion','Buff',   400, 0x0F09, [[REAG.MandrakeRoot, 5]]);
potion(2034, 'Nightsight Potion',     'Buff',    0,   0x0F06, [[REAG.SpidersSilk, 1]]);

// ---- Poison potions --------------------------------------------------
potion(2040, 'Lesser Poison Potion',  'Poison',  0,   0x0F0A, [[REAG.Nightshade, 1]]);
potion(2041, 'Poison Potion',         'Poison',  300, 0x0F0A, [[REAG.Nightshade, 3]]);
potion(2042, 'Greater Poison Potion', 'Poison',  500, 0x0F0A, [[REAG.Nightshade, 6]]);
potion(2043, 'Deadly Poison Potion',  'Poison',  750, 0x0F0A, [[REAG.Nightshade, 10]]);

// ---- Explosion potions ------------------------------------------------
potion(2050, 'Lesser Explosion Potion', 'Explosion', 0,   0x0F0D, [[REAG.SulfurousAsh, 3]]);
potion(2051, 'Explosion Potion',        'Explosion', 250, 0x0F0D, [[REAG.SulfurousAsh, 5]]);
potion(2052, 'Greater Explosion Potion','Explosion', 450, 0x0F0D, [[REAG.SulfurousAsh, 10]]);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/alchemy: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/alchemy: ' + e.message); } }
  api.log?.('crafting/alchemy: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
