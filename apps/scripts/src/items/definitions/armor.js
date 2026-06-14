// Armor item definitions — AR (armor rating) per slot per material.
// ServUO: Scripts/Items/Armor/*/*.cs — one file per piece.
//
// `ar` is the base armor rating that enters the damage-mitigation formula
// in `combat-formulas.js::applyArmor`. Final mitigation is the sum of
// worn pieces.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function armor(def) { __PENDING__.push({ kind: 'armor', ...def }); }
function shield(def) { __PENDING__.push({ kind: 'shield', ...def }); }

// ---- Leather (low AR, no STR req) ----------------------------------
armor({ id: 0x1DB9, name: 'Leather Cap',       layer: 6,  ar: 11, strReq: 10, material: 'leather' });
armor({ id: 0x13C7, name: 'Leather Gorget',    layer: 10, ar: 11, strReq: 20, material: 'leather' });
armor({ id: 0x13C6, name: 'Leather Gloves',    layer: 7,  ar: 11, strReq: 20, material: 'leather' });
armor({ id: 0x13CD, name: 'Leather Arms',      layer: 19, ar: 14, strReq: 20, material: 'leather' });
armor({ id: 0x13CB, name: 'Leather Leggings',  layer: 4,  ar: 17, strReq: 20, material: 'leather' });
armor({ id: 0x13CC, name: 'Leather Tunic',     layer: 13, ar: 23, strReq: 20, material: 'leather' });

// ---- Studded leather ------------------------------------------------
armor({ id: 0x13D0, name: 'Studded Gorget',    layer: 10, ar: 17, strReq: 25, material: 'studded' });
armor({ id: 0x13D5, name: 'Studded Gloves',    layer: 7,  ar: 17, strReq: 25, material: 'studded' });
armor({ id: 0x13DC, name: 'Studded Arms',      layer: 19, ar: 23, strReq: 25, material: 'studded' });
armor({ id: 0x13DA, name: 'Studded Leggings',  layer: 4,  ar: 26, strReq: 25, material: 'studded' });
armor({ id: 0x13DB, name: 'Studded Tunic',     layer: 13, ar: 34, strReq: 25, material: 'studded' });

// ---- Ring mail ------------------------------------------------------
armor({ id: 0x13EE, name: 'Ring Mail Arms',    layer: 19, ar: 28, strReq: 40, material: 'ring' });
armor({ id: 0x13F0, name: 'Ring Mail Gloves',  layer: 7,  ar: 25, strReq: 40, material: 'ring' });
armor({ id: 0x13F1, name: 'Ring Mail Leggings',layer: 4,  ar: 31, strReq: 40, material: 'ring' });
armor({ id: 0x13EC, name: 'Ring Mail Tunic',   layer: 13, ar: 40, strReq: 40, material: 'ring' });

// ---- Chain mail ----------------------------------------------------
armor({ id: 0x13BB, name: 'Chain Coif',        layer: 6,  ar: 28, strReq: 20, material: 'chain' });
armor({ id: 0x13BE, name: 'Chain Leggings',    layer: 4,  ar: 34, strReq: 60, material: 'chain' });
armor({ id: 0x13BF, name: 'Chain Tunic',       layer: 13, ar: 45, strReq: 60, material: 'chain' });

// ---- Plate (max AR, highest STR req) --------------------------------
armor({ id: 0x1410, name: 'Plate Arms',        layer: 19, ar: 37, strReq: 90, material: 'plate' });
armor({ id: 0x1413, name: 'Plate Gorget',      layer: 10, ar: 31, strReq: 70, material: 'plate' });
armor({ id: 0x1414, name: 'Plate Gloves',      layer: 7,  ar: 34, strReq: 70, material: 'plate' });
armor({ id: 0x1411, name: 'Plate Leggings',    layer: 4,  ar: 43, strReq: 90, material: 'plate' });
armor({ id: 0x1415, name: 'Plate Chest',       layer: 13, ar: 50, strReq: 95, material: 'plate' });
armor({ id: 0x1C04, name: 'Female Plate Chest',layer: 13, ar: 45, strReq: 65, material: 'plate' });

// ---- Helmets --------------------------------------------------------
armor({ id: 0x140C, name: 'Bascinet',          layer: 6,  ar: 23, strReq: 40, material: 'chain' });
armor({ id: 0x140E, name: 'Norse Helm',        layer: 6,  ar: 34, strReq: 75, material: 'plate' });
armor({ id: 0x1408, name: 'Close Helm',        layer: 6,  ar: 37, strReq: 95, material: 'plate' });
armor({ id: 0x1419, name: 'Plate Helm',        layer: 6,  ar: 40, strReq: 95, material: 'plate' });
armor({ id: 0x140A, name: 'Helmet',            layer: 6,  ar: 29, strReq: 50, material: 'plate' });

// ---- Bone armor -----------------------------------------------------
armor({ id: 0x1450, name: 'Bone Helm',         layer: 6,  ar: 31, strReq: 45, material: 'bone' });
armor({ id: 0x144E, name: 'Bone Arms',         layer: 19, ar: 34, strReq: 55, material: 'bone' });
armor({ id: 0x1452, name: 'Bone Leggings',     layer: 4,  ar: 40, strReq: 55, material: 'bone' });
armor({ id: 0x144F, name: 'Bone Chest',        layer: 13, ar: 45, strReq: 55, material: 'bone' });

// ---- Shields --------------------------------------------------------
shield({ id: 0x1B73, name: 'Buckler',        layer: 11, ar: 8,  strReq: 20 });
shield({ id: 0x1B7A, name: 'Wooden Shield',  layer: 11, ar: 9,  strReq: 20 });
shield({ id: 0x1B72, name: 'Bronze Shield',  layer: 11, ar: 10, strReq: 35 });
shield({ id: 0x1B7B, name: 'Metal Shield',   layer: 11, ar: 11, strReq: 45 });
shield({ id: 0x1B74, name: 'Kite Shield',    layer: 11, ar: 16, strReq: 45 });
shield({ id: 0x1B76, name: 'Heater Shield',  layer: 11, ar: 23, strReq: 90 });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('armor: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('armor: ' + e.message); } }
  api.log?.('armor: registered ' + count + ' items');
  return () => {};
}