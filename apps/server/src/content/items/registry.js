// Item catalogue registry — kept separate from the loader to avoid a
// circular dependency with `./index.js` (which imports domain files for
// side-effect registration; those domain files import `registerItem`).
//
// Two indexes:
//   • `registry`     primary, keyed by numeric art id (Map<id, def>)
//   • `byTag`        secondary, keyed by stringy `tagId` for resources /
//                    spellbook schools / hued variants that share a
//                    single art with multiple gameplay identities (an
//                    "Iron Ingot" and a "Copper Ingot" both render as
//                    art 0x1BF2 but the crafting registry needs them
//                    distinct).
//
// Callers picking by id keep current behaviour (last-write-wins on
// collisions); callers picking by tagId get the precise variant.

/** @type {Map<number, object>} */
const registry = new Map();
/** @type {Map<string, object>} */
const byTag = new Map();
/** Multi-variant index — every def per id, in registration order. Used
 *  by tooltip / loot pickers that want "all variants of this art id". */
const byIdAll = new Map();

export function registerItem(def) {
  registry.set(def.id, def);
  if (def.tagId) byTag.set(def.tagId, def);
  const list = byIdAll.get(def.id) ?? [];
  list.push(def);
  byIdAll.set(def.id, list);
}
export function getItem(id)         { return registry.get(id); }
export function getItemByTag(tag)   { return byTag.get(tag); }
export function itemVariants(id)    { return byIdAll.get(id) ?? []; }
export function itemsOfKind(kind) {
  return Array.from(registry.values()).filter((i) => i.kind === kind);
}
