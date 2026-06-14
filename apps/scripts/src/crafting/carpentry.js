// Carpentry — skill id 12. Most recipes consume wooden boards (0x1BD7).
// Reference: ServUO Scripts/Services/Craft/DefCarpentry.cs.
//
// Same `carpentry(...)` shorthand as the blacksmithing module so the
// recipe table reads as data.

// Carpentry = 12 in skills.json. The earlier value 13 collided with
// Cartography.

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 12;
const BOARDS = 0x1BD7;

function carpentry(id, name, category, minSkill, outputItemId, boards, opts = {}) {
  __PENDING__.push({
    id, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 250,
    outputItemId, outputCount: 1,
    inputs: [{ itemId: BOARDS, count: boards }],
    exceptionalChance: opts.exceptionalChance ?? 0.1,
  });
}

// ---- Weapons (wooden) -------------------------------------------------
carpentry(13001, 'Club',          'Weapons', 100, 0x13B4,  6);
carpentry(13002, 'Quarter Staff', 'Weapons', 350, 0x0E89,  8);
carpentry(13003, 'Black Staff',   'Weapons', 350, 0x0DF1,  9);
carpentry(13004, 'Gnarled Staff', 'Weapons', 700, 0x13F8, 11);

// ---- Containers / furniture ------------------------------------------
carpentry(13010, 'Wooden Box',     'Containers',   100, 0x09AA, 6);
carpentry(13011, 'Small Crate',    'Containers',   100, 0x0E7E, 4);
carpentry(13012, 'Medium Crate',   'Containers',   210, 0x0E3F, 6);
carpentry(13013, 'Large Crate',    'Containers',   400, 0x0E3D, 8);
carpentry(13014, 'Wooden Chest',   'Containers',   730, 0x0E43, 12);
carpentry(13020, 'Stool',          'Furniture',    100, 0x0A2A,  4);
carpentry(13021, 'Wooden Bench',   'Furniture',    400, 0x0B2C,  6);
carpentry(13022, 'Wooden Throne',  'Furniture',    760, 0x0B33,  8);
carpentry(13023, 'Foot Stool',     'Furniture',    110, 0x0B5E,  4);

// ---- Shields ----------------------------------------------------------
carpentry(13030, 'Wooden Shield',  'Shields',  300, 0x1B7A, 9);

// ---- Luxury furniture (ML / SA wood-types) ---------------------------
// ServUO `Scripts/Items/Decorative/...` set — premium decor that fills
// up a customer's house. All boards-only so a carpenter just keeps
// chopping logs to reach the higher tiers.
carpentry(13040, 'Elegant Low Table',  'Furniture',  500, 0x2819,  6);
carpentry(13041, 'Elegant Bench',      'Furniture',  550, 0x2DDF,  7);
carpentry(13042, 'Tall Dresser',       'Furniture',  650, 0x2832, 10);
carpentry(13043, 'Wooden Bookcase',    'Furniture',  600, 0x0A97,  8);
carpentry(13044, 'Easel',              'Furniture',  650, 0x0F65,  5);
carpentry(13045, 'Spinning Wheel',     'Furniture',  650, 0x1015,  6);
carpentry(13046, 'Loom',               'Furniture',  700, 0x1060,  8);
carpentry(13047, 'Music Stand',        'Furniture',  600, 0x0EBB,  5);
carpentry(13048, 'Picture Frame',      'Furniture',  300, 0x0C2B,  4);
carpentry(13049, 'Wall Sconce',        'Furniture',  400, 0x0B23,  3);

// ---- Bows (ranged weapons) -------------------------------------------
carpentry(13050, 'Bow',                'Weapons', 300, 0x13B2,  7);
carpentry(13051, 'Crossbow',           'Weapons', 550, 0x0F50,  8);
carpentry(13052, 'Heavy Crossbow',     'Weapons', 700, 0x13FD, 10);
carpentry(13053, 'Composite Bow',      'Weapons', 750, 0x26C2,  7);
carpentry(13054, 'Repeating Crossbow', 'Weapons', 900, 0x26C3, 10);

// ---- Quivers / arrow components --------------------------------------
carpentry(13060, 'Arrows',             'Ammo',      0, 0x0F3F,  1, { exceptionalChance: 0 });
carpentry(13061, 'Bolts',              'Ammo',     50, 0x1BFB,  1, { exceptionalChance: 0 });
carpentry(13062, 'Quiver',             'Containers', 600, 0x2FB7, 4);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/carpentry: engine missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { sys.registerRecipe(def); count++; } catch (e) { api.log?.('crafting/carpentry: ' + e.message); } }
  api.log?.('crafting/carpentry: registered ' + count + ' recipes');
  return () => {};
}
