// Clothing — robes, cloaks, doublets, tunics, kilts, skirts, hats,
// boots, sandals. Body covering items mostly with cosmetic value but
// equippable to layer slots so paperdoll renders them.
//
// Layer ids match ServUO's Layer enum (not TileFlag indexes):
//   3 shoes, 4 pants, 5 shirt, 6 helm, 12 waist, 13 inner torso,
//   17 middle torso, 20 cloak, 22 outer torso, 23 outer legs,
//   25 mount. Layer 25 must never be used by clothing.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function clothing(def) {
  __PENDING__.push({
    kind: 'clothing',
    container: false,
    twoHanded: false,
    weight: 1,
    ...def,
  });
}

// ---- Robes / cloaks (layer 22 inner / 25 cloak) ---------------------
clothing({ id: 0x1F03, name: 'Robe',         layer: 22, weight: 3 });
clothing({ id: 0x1F04, name: 'Hooded Robe',  layer: 22, weight: 4 });
clothing({ id: 0x2683, name: "Mage's Robe",  layer: 22, weight: 3 });
clothing({ id: 0x1515, name: 'Cloak',        layer: 20, weight: 3 });
clothing({ id: 0x230A, name: 'Long Cloak',   layer: 20, weight: 4 });
clothing({ id: 0x230B, name: 'Surcoat',      layer: 22, weight: 3 });

// ---- Tunics / doublets (layer 13 outerTorso) ------------------------
clothing({ id: 0x1FFA, name: 'Plain Tunic',  layer: 13, weight: 3 });
clothing({ id: 0x1FFB, name: 'Tunic',        layer: 13, weight: 3 });
clothing({ id: 0x1F7B, name: 'Doublet',      layer: 13, weight: 3 });
clothing({ id: 0x1F7C, name: 'Fancy Doublet',layer: 13, weight: 3 });
clothing({ id: 0x1F9F, name: 'Jester Suit',  layer: 13, weight: 4 });
clothing({ id: 0x1F9D, name: 'Fancy Shirt',  layer:  5, weight: 2 });
clothing({ id: 0x1517, name: 'Shirt',        layer:  5, weight: 2 });

// ---- Pants / kilts / skirts (layer 4 pants) -------------------------
clothing({ id: 0x152E, name: 'Long Pants',   layer:  4, weight: 2 });
clothing({ id: 0x1539, name: 'Short Pants',  layer:  4, weight: 2 });
clothing({ id: 0x1537, name: 'Kilt',         layer: 23, weight: 2 });
clothing({ id: 0x1516, name: 'Skirt',        layer: 23, weight: 2 });
clothing({ id: 0x1518, name: 'Half-Apron',   layer: 12, weight: 1 });
clothing({ id: 0x153B, name: 'Full Apron',   layer: 17, weight: 1 });

// ---- Hats / bandanas / wreaths (layer 6 hat) ------------------------
clothing({ id: 0x1714, name: 'Bandana',      layer:  6, weight: 1 });
clothing({ id: 0x1540, name: 'Bonnet',       layer:  6, weight: 1 });
clothing({ id: 0x1545, name: 'Floppy Hat',   layer:  6, weight: 1 });
clothing({ id: 0x1549, name: 'Wide-Brim Hat',layer:  6, weight: 1 });
clothing({ id: 0x154E, name: 'Tall Straw Hat',layer: 6, weight: 1 });
clothing({ id: 0x1718, name: 'Wizard\'s Hat',layer:  6, weight: 2 });
clothing({ id: 0x1722, name: 'Skullcap',     layer:  6, weight: 1 });
clothing({ id: 0x230D, name: 'Tricorne Hat', layer:  6, weight: 1 });
clothing({ id: 0x2304, name: 'Flowery Hat',  layer:  6, weight: 1 });
clothing({ id: 0x2306, name: 'Flower Wreath',layer:  6, weight: 1 });
clothing({ id: 0x171F, name: 'Cap',          layer:  6, weight: 1 });
clothing({ id: 0x1748, name: 'Jester Hat',   layer:  6, weight: 1 });

// ---- Boots / shoes / sandals (layer 3 shoes) ------------------------
clothing({ id: 0x170B, name: 'Boots',        layer:  3, weight: 4 });
clothing({ id: 0x170C, name: 'Shoes',        layer:  3, weight: 2 });
clothing({ id: 0x170D, name: 'Sandals',      layer:  3, weight: 1 });
clothing({ id: 0x170F, name: 'Thigh Boots',  layer:  3, weight: 5 });

// ---- Belts / sashes (layer 8 waist) ---------------------------------
clothing({ id: 0x153A, name: 'Sash',         layer: 12, weight: 1 });
clothing({ id: 0x2641, name: 'Body Sash',    layer: 12, weight: 1 });
clothing({
  id: 0xA1F6,
  name: 'First Aid Belt',
  tagId: 'first-aid-belt',
  layer: 12,
  equipLayer: 12,
  script: 'first-aid-belt',
  container: true,
  gumpId: 0x003C,
  capacity: 1,
  maxWeight: 100,
  firstAidBelt: true,
  firstAidMaxBandages: 1000,
  firstAidHealingBonus: 0,
  firstAidWeightReduction: 0,
  servuoClass: 'FirstAidBelt',
  servuoClasses: ['FirstAidBelt', 'Bandage', 'EnhancedBandage'],
  weight: 2,
});
clothing({
  id: 0xA1F6,
  name: 'Khaldun First Aid Belt',
  tagId: 'khaldun-first-aid-belt',
  layer: 12,
  equipLayer: 12,
  script: 'first-aid-belt',
  container: true,
  gumpId: 0x003C,
  capacity: 1,
  maxWeight: 100,
  firstAidBelt: true,
  firstAidMaxBandages: 1000,
  firstAidHealingBonus: 10,
  firstAidWeightReduction: 50,
  attributes: { regenHits: 2 },
  blessed: true,
  newbied: true,
  servuoClass: 'KhaldunFirstAidBelt',
  servuoClasses: ['KhaldunFirstAidBelt', 'FirstAidBelt', 'Bandage', 'EnhancedBandage'],
  weight: 2,
});

// ---- Gargoyle / Elven cosmetics -------------------------------------
clothing({ id: 0x4B95, name: 'Gargish Robe', layer: 22, weight: 3 });
clothing({ id: 0x4001, name: 'Elven Robe',   layer: 22, weight: 3 });
clothing({ id: 0x4B96, name: 'Gargish Sash', layer:  8, weight: 1 });

// ---- Ceremonial / royal --------------------------------------------
clothing({ id: 0x2683, name: 'Royal Robe',   layer: 22, weight: 3, hue: 0x47E });
clothing({ id: 0x153D, name: 'Tall Toga',    layer: 22, weight: 4 });

// ---- Holiday / event masks (layer 6 hat) ----------------------------
clothing({ id: 0x1545, name: 'Halloween Pumpkin Mask', layer: 6, weight: 1, hue: 0x44 });
clothing({ id: 0x1546, name: 'Witch Hat',    layer:  6, weight: 1, hue: 0x29 });
clothing({ id: 0x231D, name: 'Skull Helmet', layer:  6, weight: 1 });
clothing({ id: 0x2329, name: 'Demon Mask',   layer:  6, weight: 1 });
clothing({ id: 0x232A, name: 'Plague Mask',  layer:  6, weight: 1 });
clothing({ id: 0x232B, name: 'Bear Mask',    layer:  6, weight: 1 });

// ---- Headgear (helms not part of armor.js) --------------------------
clothing({ id: 0x1F4F, name: 'Hood',         layer:  6, weight: 1 });
clothing({ id: 0x171C, name: 'Tall Hat',     layer:  6, weight: 1 });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('clothing: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('clothing: ' + e.message); } }
  api.log?.('clothing: registered ' + count + ' items');
  return () => {};
}
