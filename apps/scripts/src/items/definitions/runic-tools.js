// Runic tools — material-tinted craft tools that imbue magic
// properties on exceptional crafted items. ServUO `Engines/Craft/
// RunicHammer.cs`, `RunicSewingKit.cs`, `RunicFletcherTool.cs`,
// `RunicMapmakersPen.cs`. Each carries `runicMaterial` (matches
// the resource enum: dull-copper / shadow-iron / copper / bronze /
// gold / agapite / verite / valorite, each with its own loot
// budget bracket) and `chargesLeft` (uses left).
//
// The crafting system reads these fields when a tool is selected
// for a craft; the property roller in `loot.js` rollMagicProperties
// scales item-budget against the runic tier.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

const RUNIC_MATERIALS = [
  { tag: 'dull-copper',  hue: 0x973, name: 'Dull Copper',  budget: 200 },
  { tag: 'shadow-iron',  hue: 0x966, name: 'Shadow Iron',  budget: 250 },
  { tag: 'copper',       hue: 0x96D, name: 'Copper',       budget: 300 },
  { tag: 'bronze',       hue: 0x972, name: 'Bronze',       budget: 350 },
  { tag: 'gold',         hue: 0x8A5, name: 'Gold',         budget: 400 },
  { tag: 'agapite',      hue: 0x979, name: 'Agapite',      budget: 450 },
  { tag: 'verite',       hue: 0x89F, name: 'Verite',       budget: 500 },
  { tag: 'valorite',     hue: 0x8AB, name: 'Valorite',     budget: 600 },
];

const LEATHER_MATERIALS = [
  { tag: 'spined',     hue: 0x8AC, name: 'Spined',     budget: 250 },
  { tag: 'horned',     hue: 0x845, name: 'Horned',     budget: 350 },
  { tag: 'barbed',     hue: 0x851, name: 'Barbed',     budget: 500 },
];

const WOOD_MATERIALS = [
  { tag: 'oak',        hue: 0x7DA, name: 'Oak',        budget: 200 },
  { tag: 'ash',        hue: 0x4A7, name: 'Ash',        budget: 250 },
  { tag: 'yew',        hue: 0x4A8, name: 'Yew',        budget: 300 },
  { tag: 'heartwood',  hue: 0x4A9, name: 'Heartwood',  budget: 400 },
  { tag: 'bloodwood',  hue: 0x4AA, name: 'Bloodwood',  budget: 500 },
  { tag: 'frostwood',  hue: 0x47F, name: 'Frostwood',  budget: 600 },
];

// ---- Runic Hammers (blacksmith) ------------------------------------
for (const mat of RUNIC_MATERIALS) {
  __PENDING__.push({
    kind: 'tool', category: 'runic-hammer',
    id: 0x13E4, hue: mat.hue,
    name: `${mat.name} Runic Hammer`,
    tagId: `runic-hammer-${mat.tag}`,
    runicMaterial: mat.tag,
    runicBudget: mat.budget,
    defaultCharges: 50,
    weight: 8,
  });
}

// ---- Runic Sewing Kits (tailor) ------------------------------------
for (const mat of LEATHER_MATERIALS) {
  __PENDING__.push({
    kind: 'tool', category: 'runic-sewing-kit',
    id: 0x0F9D, hue: mat.hue,
    name: `${mat.name} Runic Sewing Kit`,
    tagId: `runic-sewing-${mat.tag}`,
    runicMaterial: mat.tag,
    runicBudget: mat.budget,
    defaultCharges: 50,
    weight: 1,
  });
}

// ---- Runic Fletcher Tools (fletching) ------------------------------
for (const mat of WOOD_MATERIALS) {
  __PENDING__.push({
    kind: 'tool', category: 'runic-fletcher',
    id: 0x1022, hue: mat.hue,
    name: `${mat.name} Runic Fletcher Tool`,
    tagId: `runic-fletcher-${mat.tag}`,
    runicMaterial: mat.tag,
    runicBudget: mat.budget,
    defaultCharges: 50,
    weight: 2,
  });
}

// ---- Runic Mapmaker Pens (cartography) -----------------------------
for (const mat of WOOD_MATERIALS.slice(0, 3)) {
  __PENDING__.push({
    kind: 'tool', category: 'runic-mapmaker',
    id: 0x0FBF, hue: mat.hue,
    name: `${mat.name} Runic Mapmaker's Pen`,
    tagId: `runic-mapmaker-${mat.tag}`,
    runicMaterial: mat.tag,
    runicBudget: mat.budget,
    defaultCharges: 50,
    weight: 1,
  });
}

// ---- Repair Deeds (per-skill consumables) --------------------------
for (const skill of ['blacksmithy', 'tailoring', 'fletching', 'tinkering', 'carpentry']) {
  __PENDING__.push({
    kind: 'tool', category: 'repair-deed',
    id: 0x14F0, name: `${skill[0].toUpperCase() + skill.slice(1)} Repair Deed`,
    tagId: `repair-deed-${skill}`,
    repairSkill: skill, defaultCharges: 1,
    weight: 1,
  });
}


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('runic-tools: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('runic-tools: ' + e.message); } }
  api.log?.('runic-tools: registered ' + count + ' items');
  return () => {};
}