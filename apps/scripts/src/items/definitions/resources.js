// Resource items — raw materials produced by harvesting (Mining, Lumber-
// jacking, Fishing, Tailoring) and consumed by crafting. ServUO:
// Scripts/Items/Resource/.
//
// Each entry registers a stackable item the crafting registries pull
// from. The crafting recipe DB stores resource keys (e.g. 'iron-ingot',
// 'cloth') which look up `tagId` here for the in-world graphic to
// produce. Hue tints by metal type let the renderer paint a coloured
// ingot stack without a per-metal art id.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function resource(def) {
  __PENDING__.push({ kind: 'resource', stackable: true, ...def });
}

// ============================================================
// METALS — `iron` is the baseline; coloured metals shift hue.
// ============================================================
const ORE_ID    = 0x19B7;   // 1 ore
const INGOT_ID  = 0x1BF2;   // 1 ingot stack

resource({ id: ORE_ID,   name: 'Iron Ore',       tagId: 'ore-iron' });
resource({ id: INGOT_ID, name: 'Iron Ingots',    tagId: 'ingot-iron' });
// Coloured metals — same art, different hue. Hues from ServUO CraftResources.cs.
const METALS = [
  ['Dull Copper', 0x0973, 'dullcopper', 'DullCopper'],
  ['Shadow Iron', 0x0966, 'shadow',     'ShadowIron'],
  ['Copper',      0x096D, 'copper',     'Copper'],
  ['Bronze',      0x0972, 'bronze',     'Bronze'],
  ['Gold',        0x08A5, 'gold',       'Gold'],
  ['Agapite',     0x0979, 'agapite',    'Agapite'],
  ['Verite',      0x089F, 'verite',     'Verite'],
  ['Valorite',    0x08AB, 'valorite',   'Valorite'],
];
for (const [n, hue, key, cls] of METALS) {
  resource({ id: ORE_ID,   name: `${n} Ore`,    hue, tagId: `ore-${key}`, servuoClass: `${cls}Ore` });
  resource({ id: INGOT_ID, name: `${n} Ingots`, hue, tagId: `ingot-${key}`, servuoClass: `${cls}Ingot` });
}

// ============================================================
// WOOD
// ============================================================
const LOG_ID    = 0x1BDD;
const BOARD_ID  = 0x1BD7;
resource({ id: LOG_ID,   name: 'Logs',         tagId: 'log-oak' });
resource({ id: BOARD_ID, name: 'Boards',       tagId: 'board-oak' });
const WOODS = [
  ['Ash',         0x04A7, 'ash'],
  ['Yew',         0x04A8, 'yew'],
  ['Heartwood',   0x04AA, 'heartwood'],
  ['Bloodwood',   0x04AB, 'bloodwood'],
  ['Frostwood',   0x047F, 'frostwood'],
  ['Oak',         0x07DA, 'oakdark'],
];
for (const [n, hue, key] of WOODS) {
  resource({ id: LOG_ID,   name: `${n} Logs`,   hue, tagId: `log-${key}` });
  resource({ id: BOARD_ID, name: `${n} Boards`, hue, tagId: `board-${key}` });
}

// ============================================================
// CLOTH / LEATHER / HIDES
// ============================================================
resource({ id: 0x1F95, name: 'Cloth',          tagId: 'cloth' });
resource({ id: 0x1766, name: 'Cloth Bolt',     tagId: 'cloth-bolt' });
resource({ id: 0x0EE3, name: 'Wool',           tagId: 'wool' });
resource({ id: 0x0E1D, name: 'Cotton',         tagId: 'cotton' });
resource({ id: 0x0E1A, name: 'Yarn',           tagId: 'yarn' });
resource({ id: 0x1078, name: 'Leather',        tagId: 'leather' });
resource({ id: 0x1078, name: 'Spined Leather',     hue: 0x08AC, tagId: 'leather-spined' });
resource({ id: 0x1078, name: 'Horned Leather',     hue: 0x0845, tagId: 'leather-horned' });
resource({ id: 0x1078, name: 'Barbed Leather',     hue: 0x0851, tagId: 'leather-barbed' });
resource({ id: 0x1079, name: 'Hides',          tagId: 'hide' });

// ============================================================
// FISHING / SCRIBE / ALCHEMY
// ============================================================
resource({ id: 0x09CC, name: 'Fish Steaks',    tagId: 'fish-steak' });
resource({ id: 0x099F, name: 'Raw Fish Steak', tagId: 'fish-steak-raw' });
resource({ id: 0x0E72, name: 'Empty Bottle',   tagId: 'bottle' });
resource({ id: 0x0EF3, name: 'Blank Scroll',   tagId: 'scroll-blank' });
resource({
  id: 0x0E21,
  hue: 0x08A5,
  name: 'Enhanced Bandage',
  tagId: 'enhanced-bandage',
  script: 'bandage',
  bandageHealingBonus: 10,
  servuoClass: 'EnhancedBandage',
  servuoClasses: ['EnhancedBandage', 'Bandage', 'ICommodity'],
});

// ============================================================
// REAGENTS — already registered elsewhere as consumables, but mirror
// the resource tag here so crafting can pull from a single namespace.
// ============================================================
resource({ id: 0x0F7A, name: 'Black Pearl',    tagId: 'reagent-pearl' });
resource({ id: 0x0F7B, name: 'Blood Moss',     tagId: 'reagent-bloodmoss' });
resource({ id: 0x0F84, name: 'Garlic',         tagId: 'reagent-garlic' });
resource({ id: 0x0F85, name: 'Ginseng',        tagId: 'reagent-ginseng' });
resource({ id: 0x0F86, name: 'Mandrake Root',  tagId: 'reagent-mandrake' });
resource({ id: 0x0F88, name: 'Nightshade',     tagId: 'reagent-nightshade' });
resource({ id: 0x0F8C, name: 'Spider Silk',    tagId: 'reagent-spidersilk' });
resource({ id: 0x0F8D, name: 'Sulfurous Ash',  tagId: 'reagent-sulfash' });

// ============================================================
// GEMS
// ============================================================
const GEMS = [
  ['Citrine',    0x0F15], ['Amber',     0x0F25], ['Tourmaline', 0x0F2D],
  ['Amethyst',   0x0F16], ['Sapphire',  0x0F19], ['Emerald',    0x0F10],
  ['Ruby',       0x0F13], ['Diamond',   0x0F26], ['Star Sapphire', 0x0F21],
];
for (const [name, id] of GEMS) {
  resource({ id, name, tagId: `gem-${name.toLowerCase().replace(/\s+/g, '-')}` });
}


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('resources: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('resources: ' + e.message); } }
  api.log?.('resources: registered ' + count + ' items');
  return () => {};
}
