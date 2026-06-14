// Store inventory — ENGINE ONLY.
//
// Catalogue (SKU → price/itemId/category) lives in
// apps/scripts/src/data/config/store-catalogue.json and is registered at
// startup by apps/scripts/src/systems/economy/store-inventory.js.
//
// Engine responsibilities:
//   - hold the catalogue (set by script via setCatalogue)
//   - findBySku, byCategory, totalSkus
//   - seedUltimaStore hook for the live shop system

let _catalogue = [];

export function setCatalogue(list) {
  _catalogue = Array.isArray(list) ? list.slice() : [];
}

export function STORE_CATALOGUE() { return _catalogue.slice(); }
export function totalSkus() { return _catalogue.length; }
export function findBySku(sku) { return _catalogue.find((e) => e.sku === sku) ?? null; }
export function byCategory(category) { return _catalogue.filter((e) => e.category === category); }

/** Integration hook for the Ultima Store vendor. */
export function seedUltimaStore(store) {
  if (!store?.addSku || !store?.hasSku) return 0;
  let added = 0;
  for (const e of _catalogue) {
    if (store.hasSku(e.sku)) continue;
    store.addSku(e);
    added++;
  }
  return added;
}
