// Item catalogue — ENGINE ONLY (registry façade).
//
// Content is loaded by the script runtime from `apps/scripts/src/items/`.
// Each script file registers items via `api.catalog.items.registerItem`
// (the function re-exported below). No eager imports — keeps the engine
// decoupled from content and allows hot-reload of items at runtime.

export {
  getItem, registerItem, unregisterItem, itemsOfKind,
  getItemByDefinition, getItemByTag, itemVariants,
} from './registry.js';
