// Extended armor sets — Gargish, Dragon, Leaf, Hide, Woodland, Samurai,
// Stone, special crimson belts. Mirrors ServUO `Items/Equipment/Armor/`
// and `Items/Equipment/Suits/` (~150 .cs files).



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function armor(def) { __PENDING__.push({ kind: 'armor', ...def }); }

// ---- Gargish armor (8 pieces) ---------------------------------------
const GARGISH = [
  ['Gargish Stone Arms',     0x4D6E, 19, 38, 80, 'stone'],
  ['Gargish Stone Chest',    0x4D6C, 13, 50, 95, 'stone'],
  ['Gargish Stone Kilt',     0x4D6D, 4,  44, 90, 'stone'],
  ['Gargish Plate Arms',     0x4D71, 19, 36, 80, 'plate'],
  ['Gargish Plate Chest',    0x4D6F, 13, 48, 95, 'plate'],
  ['Gargish Plate Kilt',     0x4D70, 4,  42, 90, 'plate'],
  ['Gargish Leather Arms',   0x4D74, 19, 16, 25, 'leather'],
  ['Gargish Leather Chest',  0x4D72, 13, 24, 25, 'leather'],
];
for (const [name, id, layer, ar, strReq, material] of GARGISH) {
  armor({ id, name, layer, ar, strReq, material, race: 'gargoyle' });
}

// ---- Dragon armor (5 pieces) ----------------------------------------
const DRAGON = [
  ['Dragon Helm',        0x2645, 6,  44, 60],
  ['Dragon Arms',        0x2641, 19, 50, 65],
  ['Dragon Chest',       0x2642, 13, 60, 75],
  ['Dragon Gloves',      0x2643, 7,  44, 60],
  ['Dragon Leggings',    0x2644, 4,  53, 70],
];
for (const [name, id, layer, ar, strReq] of DRAGON) {
  armor({ id, name, layer, ar, strReq, material: 'dragon', resists: { fire: 30 } });
}

// ---- Leaf armor (elven, 5 pieces) -----------------------------------
const LEAF = [
  ['Leaf Tunic',     0x2FBC, 13, 22, 30, 'leaf'],
  ['Leaf Arms',      0x2FBA, 19, 16, 25, 'leaf'],
  ['Leaf Leggings',  0x2FBB, 4,  19, 25, 'leaf'],
  ['Leaf Gloves',    0x2FB9, 7,  14, 20, 'leaf'],
  ['Leaf Tonlet',    0x2FB8, 6,  14, 20, 'leaf'],
];
for (const [name, id, layer, ar, strReq, material] of LEAF) {
  armor({ id, name, layer, ar, strReq, material, race: 'elf' });
}

// ---- Hide armor (gargish hide variant, 5 pieces) --------------------
const HIDE = [
  ['Hide Tunic',     0x2B72, 13, 18, 25, 'hide'],
  ['Hide Pauldrons', 0x2B70, 19, 14, 25, 'hide'],
  ['Hide Pants',     0x2B73, 4,  16, 25, 'hide'],
  ['Hide Gloves',    0x2B6E, 7,  14, 25, 'hide'],
  ['Hide Half-Helm', 0x2B71, 6,  14, 25, 'hide'],
];
for (const [name, id, layer, ar, strReq, material] of HIDE) {
  armor({ id, name, layer, ar, strReq, material });
}

// ---- Woodland armor (elven plate, 7 pieces) -------------------------
const WOODLAND = [
  ['Woodland Helm',     0x2FBE, 6,  44, 60, 'woodland'],
  ['Woodland Gorget',   0x2FBD, 10, 38, 60, 'woodland'],
  ['Woodland Arms',     0x2FBF, 19, 50, 65, 'woodland'],
  ['Woodland Chest',    0x2FC0, 13, 60, 75, 'woodland'],
  ['Woodland Gloves',   0x2FC1, 7,  44, 60, 'woodland'],
  ['Woodland Leggings', 0x2FC2, 4,  53, 70, 'woodland'],
  ['Woodland Belt',     0x2B68, 21, 8,  20, 'woodland'],
];
for (const [name, id, layer, ar, strReq, material] of WOODLAND) {
  armor({ id, name, layer, ar, strReq, material, race: 'elf' });
}

// ---- Samurai (Tokuno: leather + plate) -------------------------------
const SAMURAI = [
  ['Leather Do',         0x277A, 13, 30, 30, 'leather'],
  ['Leather Hiro Sode',  0x277B, 19, 22, 30, 'leather'],
  ['Leather Suneate',    0x277E, 4,  26, 30, 'leather'],
  ['Leather Ninja Hood', 0x278F, 6,  18, 25, 'leather'],
  ['Plate Do',           0x2780, 13, 50, 90, 'plate'],
  ['Plate Hiro Sode',    0x2781, 19, 38, 80, 'plate'],
  ['Plate Suneate',      0x2784, 4,  42, 90, 'plate'],
  ['Plate Hatsuburi',    0x2782, 6,  36, 75, 'plate'],
  ['Bone Do',            0x277C, 13, 45, 55, 'bone'],
  ['Bone Arms',          0x277D, 19, 34, 55, 'bone'],
  ['Bone Leggings',      0x2780, 4,  40, 55, 'bone'],
  ['Bone Helm',          0x278E, 6,  31, 45, 'bone'],
];
for (const [name, id, layer, ar, strReq, material] of SAMURAI) {
  armor({ id, name, layer, ar, strReq, material, region: 'tokuno' });
}

// ---- Special belts / accessories ------------------------------------
armor({ id: 0x1086, name: 'Crimson Cincture',       layer: 21, ar: 0, hue: 0x485, str: 10, accessory: true });
armor({ id: 0x1086, name: 'Folded Steel Glasses',   layer: 12, ar: 0, dex: 5, accessory: true });
armor({ id: 0x1086, name: 'Mage Glasses',           layer: 12, ar: 0, int: 5, magery: 1, accessory: true });
armor({ id: 0x1086, name: 'ML Glasses',             layer: 12, ar: 0, anatomy: 5, accessory: true });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('armor-extra: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('armor-extra: ' + e.message); } }
  api.log?.('armor-extra: registered ' + count + ' items');
  return () => {};
}