// Item-type resolver — bridges ServUO C# type names (BlackPearl,
// RefreshPotion, IronIngot, …) to concrete itemIds (graphic ids).
//
// Source data: `apps/scripts/src/data/config/item-types.json`, produced by
// `packages/extractor/servuo-item-types.js`. The extractor catches ~2400
// of ~2700 Item subclasses; the rest inherit their itemId from a base
// class and don't appear here.
//
// Resolution chain in `resolve()`:
//   1. Direct hit on the loaded JSON map (case-sensitive, ServUO-style).
//   2. Case-insensitive fallback for tooling that lower-cased names.
//   3. Caller's optional template registry — for hand-authored items.
//   4. Heuristic split: "RefreshPotion" → "Refresh" + "Potion" — try
//      the suffix as a base type (potion → 0xF0E generic graphic).
//
// Returns `null` when nothing matches; callers decide whether to skip
// the entry or substitute a sentinel graphic.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '..', '..', '..', 'scripts', 'src', 'data', 'config', 'item-types.json');

let _cache = null;
let _ciIndex = null;        // case-insensitive lookup

function load() {
  if (_cache !== null) return _cache;
  if (!fs.existsSync(FILE)) { _cache = {}; _ciIndex = {}; return _cache; }
  try {
    _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
  } catch (e) {
    console.warn(`[item-types] load failed: ${e.message}`);
    _cache = {};
  }
  _ciIndex = Object.create(null);
  for (const k of Object.keys(_cache)) _ciIndex[k.toLowerCase()] = k;
  return _cache;
}

// Last-ditch fallback graphics for common base types — when neither the
// JSON nor the template registry recovers an itemId, the suffix of the
// type name often hints at category. These keep the spawn pipeline
// from outright failing on rare ServUO subclasses.
const SUFFIX_FALLBACK = [
  ['Potion',     0xF0E],   // generic potion bottle
  ['Scroll',     0x1F4D],  // scroll graphic
  ['Bandage',    0x0E21],
  ['Bag',        0x0E76],
  ['Chest',      0x0E40],
  ['Ingot',      0x1BF2],
  ['Log',        0x1BDD],
  ['Hide',       0x1078],
  ['Cloth',      0x1766],
  ['Sword',      0x13B6],
  ['Bow',        0x13B2],
  ['Crossbow',   0x0F4F],
  ['Dagger',     0x0F51],
  ['Axe',        0x0F49],
  ['Mace',       0x0FB4],
  ['Shield',     0x1B72],
  ['Helm',       0x140E],
  ['Robe',       0x1F03],
];

/**
 * Resolve a ServUO type name to `{itemId, hue, base}` or null.
 *
 * @param {string} typeName        ServUO class name (e.g. "BlackPearl")
 * @param {Object} [opts]
 * @param {(name:string)=>any} [opts.templateLookup]  optional fallback that
 *   takes a type name and returns `{ itemId }`-shaped row from the
 *   server's hand-authored template registry.
 * @returns {{itemId:number, hue:number, base?:string} | null}
 */
export function resolveItemType(typeName, opts = {}) {
  if (!typeName) return null;
  const map = load();
  if (map[typeName]) return map[typeName];
  const ci = _ciIndex[String(typeName).toLowerCase()];
  if (ci) return map[ci];
  // Optional template lookup (script-side authored items).
  const t = opts.templateLookup?.(typeName);
  if (t && Number.isFinite(t.itemId)) {
    return { itemId: t.itemId, hue: t.hue ?? 0 };
  }
  // Suffix heuristic — the type name often ends with the base type.
  for (const [suffix, graphic] of SUFFIX_FALLBACK) {
    if (typeName.endsWith(suffix)) {
      return { itemId: graphic, hue: 0, _fromSuffix: suffix };
    }
  }
  return null;
}

export function allItemTypes() { return load(); }

/** Diagnostic — list type names that resolve. */
export function knownItemTypeCount() { return Object.keys(load()).length; }
