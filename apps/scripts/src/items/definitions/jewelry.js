// Jewelry item definitions — rings, bracelets, necklaces, earrings.
// ServUO: Scripts/Items/Equipment/Jewelry/*.cs (BaseRing, BaseNecklace, etc.)
//
// Jewelry has no AR; it's a pure magic-affix carrier. Rings/bracelets
// roll int-mod / str-mod / mana-regen. Necklaces add resists. Earrings
// (rare) add elemental damage. The roll itself happens in `world/loot.js`
// via the magic-properties table; this file just registers the slot
// metadata the equip pipeline needs.
//
// Layers (ClassicUO Game/Data/Layer.cs):
//   ring     0x0F = 15
//   bracelet 0x07 =  7  (also gloves; jewelry is recognised by `.kind`)
//   necklace 0x10 = 16
//   earrings 0x12 = 18



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function jewelry(def) {
  // Jewelry doesn't carry weapon/armor stats but the equip flow uses
  // `kind` to choose paperdoll slot rendering. Stamping `clothing: true`
  // routes through the same equip path as cloth.
  __PENDING__.push({ kind: 'jewelry', clothing: true, ...def });
}

// ---- Rings (gold + silver) -----------------------------------------
jewelry({ id: 0x108A, name: 'Gold Ring',        layer: 15, slot: 'ring',     material: 'gold'   });
jewelry({ id: 0x1F09, name: 'Silver Ring',      layer: 15, slot: 'ring',     material: 'silver' });
jewelry({ id: 0x108B, name: 'Engagement Ring',  layer: 15, slot: 'ring',     material: 'gold', uniqueArt: true });

// ---- Bracelets -----------------------------------------------------
jewelry({ id: 0x1F06, name: 'Gold Bracelet',    layer: 15, slot: 'bracelet', material: 'gold'   });
jewelry({ id: 0x1F05, name: 'Silver Bracelet',  layer: 15, slot: 'bracelet', material: 'silver' });

// ---- Necklaces -----------------------------------------------------
jewelry({ id: 0x1085, name: 'Gold Necklace',    layer: 16, slot: 'necklace', material: 'gold'   });
jewelry({ id: 0x1088, name: 'Silver Necklace',  layer: 16, slot: 'necklace', material: 'silver' });
jewelry({ id: 0x1086, name: 'Gold Beads',       layer: 16, slot: 'necklace', material: 'gold'   });
jewelry({ id: 0x1089, name: 'Silver Beads',     layer: 16, slot: 'necklace', material: 'silver' });

// ---- Earrings ------------------------------------------------------
jewelry({ id: 0x1087, name: 'Gold Earrings',    layer: 18, slot: 'earrings', material: 'gold'   });
jewelry({ id: 0x1F08, name: 'Silver Earrings',  layer: 18, slot: 'earrings', material: 'silver' });

// Magic affixes are layered on top of the base graphics at runtime via
// `world/loot.js::rollMagicProperties` — no separate "magical" entry
// here, since the registry is keyed by art id and would otherwise clash.


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('jewelry: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('jewelry: ' + e.message); } }
  api.log?.('jewelry: registered ' + count + ' items');
  return () => {};
}