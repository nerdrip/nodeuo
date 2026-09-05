// Tailoring — skill id 35. Uses bolts of cloth (0x0F95) and leather
// (0x1081). ServUO reference: Scripts/Services/Craft/DefTailoring.cs.

// Audit #43 P1-1 — Tailoring is id 35 (skills.json:36). Was 8
// (Blacksmithy) → every tailor recipe registered under blacksmithy;
// `[craft list tailoring` blank, tailor BODs never resolved targets.

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 35;
// Registry ids are global. The legacy 8xxx range overlaps fletching; expose
// tailoring under 35xxx while retaining compact source-table suffixes.
const RECIPE_ID_OFFSET = 27000;
const CLOTH = 0x0F95;
const LEATHER = 0x1081;

function tailor(id, name, category, minSkill, outputItemId, material, count, opts = {}) {
  __PENDING__.push({
    id: id + RECIPE_ID_OFFSET, name, category, skillId: SKILL,
    minSkill, maxSkill: opts.maxSkill ?? minSkill + 250,
    outputItemId, outputCount: 1,
    toolKind: 'tailor',
    inputs: [{ itemId: material, count }],
    exceptionalChance: opts.exceptionalChance ?? 0.1,
  });
}

// ---- Cloth clothing ---------------------------------------------------
tailor(8001, 'Plain Shirt',       'Clothing',   0, 0x1517, CLOTH, 3);
tailor(8002, 'Fancy Shirt',       'Clothing',   0, 0x1EFD, CLOTH, 4);
tailor(8003, 'Short Pants',       'Clothing',   0, 0x152E, CLOTH, 3);
tailor(8004, 'Long Pants',        'Clothing',   0, 0x1539, CLOTH, 4);
tailor(8005, 'Kilt',              'Clothing',  80, 0x1537, CLOTH, 4);
tailor(8006, 'Skirt',             'Clothing',  80, 0x1516, CLOTH, 4);
tailor(8007, 'Body Sash',         'Clothing',   0, 0x1541, CLOTH, 2);
tailor(8008, 'Half Apron',        'Clothing',   0, 0x153B, CLOTH, 3);
tailor(8009, 'Full Apron',        'Clothing',   0, 0x153D, CLOTH, 4);
tailor(8010, 'Doublet',           'Clothing',   0, 0x1F7B, CLOTH, 4);
tailor(8011, 'Tunic',             'Clothing',   0, 0x1FA1, CLOTH, 5);
tailor(8012, 'Cloak',             'Clothing',   0, 0x1515, CLOTH, 5);
tailor(8013, 'Jester Suit',       'Clothing',   0, 0x1F9F, CLOTH, 5);
tailor(8014, 'Robe',              'Clothing',   0, 0x1F03, CLOTH, 5);
tailor(8015, 'Hooded Robe',       'Clothing', 600, 0x1F04, CLOTH, 8);

// ---- Hats -------------------------------------------------------------
tailor(8020, 'Skullcap',          'Hats',       0, 0x1544, CLOTH, 2);
tailor(8021, 'Bandana',           'Hats',       0, 0x1540, CLOTH, 2);
tailor(8022, 'Floppy Hat',        'Hats',       0, 0x1713, CLOTH, 2);
tailor(8023, 'Wide-brim Hat',     'Hats',       0, 0x1715, CLOTH, 3);
tailor(8024, 'Straw Hat',         'Hats',       0, 0x1717, CLOTH, 3);
tailor(8025, 'Tall Straw Hat',    'Hats',       0, 0x1714, CLOTH, 3);
tailor(8026, 'Wizard Hat',        'Hats',     100, 0x1718, CLOTH, 4);

// ---- Leather armor ----------------------------------------------------
tailor(8030, 'Leather Cap',       'Leather',    0, 0x1DB9, LEATHER, 4);
tailor(8031, 'Leather Gorget',    'Leather',  400, 0x13C7, LEATHER, 6);
tailor(8032, 'Leather Gloves',    'Leather',  400, 0x13C6, LEATHER, 6);
tailor(8033, 'Leather Arms',      'Leather',  450, 0x13CD, LEATHER, 8);
tailor(8034, 'Leather Leggings',  'Leather',  500, 0x13CB, LEATHER, 10);
tailor(8035, 'Leather Chest',     'Leather',  530, 0x13CC, LEATHER, 12);

// ---- Studded armor ----------------------------------------------------
tailor(8040, 'Studded Gorget',    'Studded',  625, 0x13D0, LEATHER, 6);
tailor(8041, 'Studded Gloves',    'Studded',  650, 0x13D5, LEATHER, 8);
tailor(8042, 'Studded Arms',      'Studded',  700, 0x13DC, LEATHER, 10);
tailor(8043, 'Studded Leggings',  'Studded',  750, 0x13DA, LEATHER, 12);
tailor(8044, 'Studded Chest',     'Studded',  800, 0x13DB, LEATHER, 14);

// ---- Bone armor -------------------------------------------------------
tailor(8050, 'Bone Helm',         'Bone',     650, 0x1450, LEATHER, 8);
tailor(8051, 'Bone Arms',         'Bone',     700, 0x144E, LEATHER, 10);
tailor(8052, 'Bone Gloves',       'Bone',     700, 0x1450, LEATHER, 8);
tailor(8053, 'Bone Leggings',     'Bone',     750, 0x1452, LEATHER, 12);
tailor(8054, 'Bone Chest',        'Bone',     800, 0x144F, LEATHER, 14);


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/tailoring: engine missing, skipping'); return () => {}; }
  let count = 0;
  const owned = [];
  for (const def of __PENDING__) { try { const registered = sys.registerRecipe(def); if (registered !== false) { owned.push(registered ?? sys.getRecipe?.(def.id) ?? def); count++; } } catch (e) { api.log?.('crafting/tailoring: ' + e.message); } }
  api.log?.('crafting/tailoring: registered ' + count + ' recipes');
  return () => { for (const def of owned) sys.unregisterRecipe?.(def.id, def); };
}
