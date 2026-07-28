// Item-type resolver — bridges stable ServUO definition ids (BlackPearl,
// RefreshPotion, IronIngot, …) to concrete art ids (UO graphic ids).
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
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
    _cache = Object.create(null);
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue;
      const definitionId = String(value.definitionId ?? value.id ?? key);
      const artId = Number(value.artId ?? value.itemId);
      if (!Number.isInteger(artId) || artId < 0 || artId > 0xFFFF) continue;
      _cache[key] = {
        ...value,
        definitionId,
        id: definitionId,
        artId,
        // Runtime-only backwards-compatible wire graphic alias.
        itemId: artId,
        name: value.name ?? definitionId,
        hue: Number(value.hue ?? 0) | 0,
      };
    }
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
 * Resolve a ServUO type name to an unambiguous definition. `itemId` is kept
 * as a compatibility alias of `artId` for callers that build UO packets.
 *
 * @param {string} typeName        ServUO class name (e.g. "BlackPearl")
 * @param {Object} [opts]
 * @param {(name:string)=>any} [opts.templateLookup]  optional fallback that
 *   takes a type name and returns `{ itemId }`-shaped row from the
 *   server's hand-authored template registry.
 * @returns {{definitionId:string, id:string, artId:number, itemId:number, name:string, hue:number, script?:string|null, base?:string} | null}
 */
export function resolveItemType(typeName, opts = {}) {
  if (!typeName) return null;
  const map = load();
  if (map[typeName]) return map[typeName];
  const ci = _ciIndex[String(typeName).toLowerCase()];
  if (ci) return map[ci];
  // Optional template lookup (script-side authored items).
  const t = opts.templateLookup?.(typeName);
  const templateArtId = t?.artId ?? t?.itemId;
  if (t && Number.isFinite(templateArtId)) {
    const definitionId = String(t.definitionId ?? t.id ?? t.name ?? typeName);
    return {
      definitionId, id: definitionId,
      artId: templateArtId, itemId: templateArtId,
      name: t.label ?? t.name ?? definitionId,
      hue: t.hue ?? 0, script: t.script ?? null,
    };
  }
  // Suffix heuristic — the type name often ends with the base type.
  for (const [suffix, graphic] of SUFFIX_FALLBACK) {
    if (typeName.endsWith(suffix)) {
      return {
        definitionId: String(typeName), id: String(typeName),
        artId: graphic, itemId: graphic, name: String(typeName), hue: 0,
        script: null, _fromSuffix: suffix,
      };
    }
  }
  return null;
}

export function allItemTypes() { return load(); }

/** Diagnostic — list type names that resolve. */
export function knownItemTypeCount() { return Object.keys(load()).length; }
