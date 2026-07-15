// Blacksmithing — skill id 8. Requires iron ingots (0x1BF2). ServUO
// reference: Scripts/Services/Craft/DefBlacksmithy.cs.
//
// Pattern: each recipe is a single `smithing(...)` call so the weapon /
// armor catalogue reads like a data table, not a wall of boilerplate.

// Blacksmithy skill id = 8 (skills.json canonical 1-based table). Earlier
// drafts used 7 which is Begging — recipes trained the wrong skill.

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 8;
const IRON_INGOT = 0x1BF2;

function smithing(id, name, category, minSkill, outputItemId, ingots, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 250,
    outputItemId, outputCount: 1,
    inputs: [{ itemId: IRON_INGOT, count: ingots }],
    exceptionalChance: opts.exceptionalChance ?? 0.1,
  });
}

// ---- Weapons -----------------------------------------------------------
smithing(7001, 'Dagger',        'Weapons',   0, 0x0F51, 3);
smithing(7002, 'Short Spear',   'Weapons', 440, 0x1403, 6);
smithing(7003, 'Katana',        'Weapons', 450, 0x13FE, 8);
smithing(7004, 'Kryss',         'Weapons', 440, 0x1401, 6);
smithing(7005, 'Mace',          'Weapons', 100, 0x0F5C, 6);
smithing(7006, 'War Mace',      'Weapons', 430, 0x1407, 14);
smithing(7007, 'Maul',          'Weapons', 100, 0x143B, 8);
smithing(7008, 'Halberd',       'Weapons', 660, 0x143E, 20);
smithing(7009, 'Longsword',     'Weapons', 500, 0x0F61, 12);
smithing(7010, 'Scimitar',      'Weapons', 450, 0x13B6, 10);
smithing(7011, 'Broadsword',    'Weapons', 300, 0x0F5E, 10);
smithing(7012, 'Hammer Pick',   'Weapons', 700, 0x143D, 16);
smithing(7013, 'Two-Handed Axe','Weapons', 700, 0x1443, 16);
smithing(7014, 'Battle Axe',    'Weapons', 350, 0x13FB, 14);
smithing(7015, 'War Hammer',    'Weapons', 900, 0x1439, 16);

// ---- Helmets ----------------------------------------------------------
smithing(7020, 'Bascinet',      'Helmets', 100, 0x140C, 10);
smithing(7021, 'Chain Coif',    'Helmets', 290, 0x13BB, 10);
smithing(7022, 'Norse Helm',    'Helmets', 450, 0x140E, 10);
smithing(7023, 'Close Helm',    'Helmets', 700, 0x1408, 15);
smithing(7024, 'Plate Helm',    'Helmets', 750, 0x1419, 15);
smithing(7025, 'Helmet',        'Helmets', 500, 0x140A, 12);

// ---- Chest armor ------------------------------------------------------
smithing(7030, 'Ring Tunic',    'Chest', 350, 0x13EC, 16);
smithing(7031, 'Chain Chest',   'Chest', 490, 0x13BF, 18);
smithing(7032, 'Plate Chest',   'Chest', 900, 0x1415, 25);
smithing(7033, 'Female Plate',  'Chest', 700, 0x1C04, 20);

// ---- Arm / leg pieces -------------------------------------------------
smithing(7035, 'Ring Arms',     'Arms',  350, 0x13EE, 14);
smithing(7036, 'Chain Legs',    'Legs',  480, 0x13BE, 18);
smithing(7037, 'Plate Arms',    'Arms',  700, 0x1410, 18);
smithing(7038, 'Plate Legs',    'Legs',  850, 0x1411, 20);
smithing(7039, 'Plate Gorget',  'Neck',  650, 0x1413, 10);
smithing(7040, 'Plate Gloves',  'Hands', 700, 0x1414, 12);

// ---- Shields ----------------------------------------------------------
smithing(7050, 'Buckler',       'Shields', 100, 0x1B73, 10);
smithing(7051, 'Bronze Shield', 'Shields', 220, 0x1B72, 12);
smithing(7052, 'Metal Shield',  'Shields', 450, 0x1B7B, 18);
smithing(7053, 'Kite Shield',   'Shields', 525, 0x1B74, 16);
smithing(7054, 'Heater Shield', 'Shields', 900, 0x1B76, 23);
// Wooden Shield belongs to carpentry (recipe 13030); it cannot be expressed
// as an ingot recipe and previously failed validation on every startup.

// =====================================================================
//  EXTENDED SMITHING — Tokuno + Gargish + Special weapons + crafting
//  utilities + horse barding / stirrups.
// =====================================================================

// Tokuno blades (skill 41)
smithing(7060, 'Bokuto',         'Tokuno',     400, 0x27A2, 8);
smithing(7061, 'Daisho',         'Tokuno',     500, 0x27A3, 10);
smithing(7062, 'Lajatang',       'Tokuno',     650, 0x27A5, 14);
smithing(7063, 'No-Dachi',       'Tokuno',     750, 0x27A6, 16);
smithing(7064, 'Tetsubo',        'Tokuno',     700, 0x27A8, 14);
smithing(7065, 'Tessen',         'Tokuno',     500, 0x27AB, 8);
smithing(7066, 'Wakizashi',      'Tokuno',     400, 0x27AD, 6);
smithing(7067, 'Naginata',       'Tokuno',     650, 0x27AF, 14);
smithing(7068, 'Kama',           'Tokuno',     350, 0x27A1, 8);

// Tokuno armor (samurai)
smithing(7070, 'Plate Do',          'Tokuno', 700, 0x2780, 25);
smithing(7071, 'Plate Hiro Sode',   'Tokuno', 600, 0x2781, 18);
smithing(7072, 'Plate Suneate',     'Tokuno', 700, 0x2784, 20);
smithing(7073, 'Plate Hatsuburi',   'Tokuno', 600, 0x2782, 15);

// Gargish weapons / armor (race-locked)
smithing(7080, 'Gargish Tessen',    'Gargish', 500, 0x48B2, 8);
smithing(7081, 'Gargish Lance',     'Gargish', 800, 0x48B6, 18);
smithing(7082, 'Gargish Battle Axe','Gargish', 600, 0x48B8, 16);
smithing(7083, 'Gargish Bardiche',  'Gargish', 750, 0x48BA, 18);
smithing(7084, 'Gargish War Hammer','Gargish', 900, 0x48D0, 16);
smithing(7085, 'Gargish Stone Arms', 'Gargish', 550, 0x4D6E, 18);
smithing(7086, 'Gargish Stone Chest','Gargish', 800, 0x4D6C, 28);
smithing(7087, 'Gargish Plate Arms','Gargish', 600, 0x4D71, 18);
smithing(7088, 'Gargish Plate Chest','Gargish', 850, 0x4D6F, 28);

// ML / SA exotics
smithing(7090, 'Diamond Mace',     'Exotic',   650, 0x2D24, 14);
smithing(7091, 'Rune Blade',       'Exotic',   700, 0x2D34, 14);
smithing(7092, 'Radiant Scimitar', 'Exotic',   650, 0x2D32, 14);
smithing(7093, 'Assassin Spike',   'Exotic',   700, 0x2D35, 10);
smithing(7094, 'Leafblade',        'Exotic',   650, 0x2D31, 12);
smithing(7095, 'War Cleaver',      'Exotic',   650, 0x2D2D, 14);

// Crafting tools (smith-class)
smithing(7100, 'Smithy Hammer',    'Tools',     50, 0x13E3, 4);
smithing(7101, 'Tongs',            'Tools',     30, 0x0FBB, 4);
smithing(7102, 'Tongs (Master)',   'Tools',    400, 0x0FBB, 4);

// Horse barding (gargish/dragon armor for mounts)
smithing(7110, 'Horse Plate Barding',  'Barding', 700, 0x4583, 35);
smithing(7111, 'Horse Chain Barding',  'Barding', 500, 0x4582, 25);

// Cannons + cannon balls (high seas content)
smithing(7120, 'Light Cannon',     'Naval', 850, 0x4690, 50);
smithing(7121, 'Heavy Cannon',     'Naval', 950, 0x4691, 75);
smithing(7122, 'Cannon Ball',      'Naval', 200, 0x232C, 4);
smithing(7123, 'Powder Charge',    'Naval', 250, 0x2334, 2);

// Ore smelting is handled by the dedicated harvesting/refining interaction,
// not by zero-cost craft recipes (which would mint resources from nothing).

// Decorative metalwork
smithing(7140, 'Iron Brazier',     'Decorative', 600, 0x0E31, 12);
smithing(7141, 'Iron Lantern',     'Decorative', 400, 0x0A18, 6);
smithing(7142, 'Iron Anvil',       'Decorative', 800, 0x0FAF, 30);
smithing(7143, 'Iron Bench',       'Decorative', 700, 0x0B2C, 16);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/blacksmithing: engine missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { sys.registerRecipe(def); count++; } catch (e) { api.log?.('crafting/blacksmithing: ' + e.message); } }
  api.log?.('crafting/blacksmithing: registered ' + count + ' recipes');
  return () => {};
}
