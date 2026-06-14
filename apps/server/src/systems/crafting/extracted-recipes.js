// Extracted recipe catalog — loaded from
// `apps/scripts/src/data/config/recipes.json` (output of
// `packages/extractor/servuo-recipes.js`).
//
// Why a SEPARATE catalog from `registry.js`:
//   The authored recipes are full domain objects with itemIds, output
//   amounts, and per-recipe success curves. The extracted entries hold
//   only ServUO type names (e.g. "BlackPearl", "RefreshPotion") plus
//   the skill range. We can't mint a finished `CraftRecipe` from those
//   alone — they're a *reference* the runtime exposes for two uses:
//     1. `[recipes <skill>` listing for players & GMs
//     2. an authoring shortcut: scripts can pull a row, look up the
//        canonical itemId via the item catalog, and call
//        `registerRecipe()` themselves.
//
// API:
//   - `loadExtractedRecipes()` — read JSON once, cache.
//   - `extractedRecipesForSkill(skill)` — returns an array of
//     { result, minSkill, maxSkill, resources:[{type,qty}] } rows
//     for a given skill name (lowercase).
//   - `extractedRecipeSkills()` — sorted list of skill keys present.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '..', '..', '..', '..', 'scripts', 'src', 'data', 'config', 'recipes.json');

let _cache = null;

export function loadExtractedRecipes() {
  if (_cache !== null) return _cache;
  if (!fs.existsSync(FILE)) { _cache = {}; return _cache; }
  try {
    _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
  } catch (e) {
    console.warn(`[crafting] extracted recipes load failed: ${e.message}`);
    _cache = {};
  }
  return _cache;
}

export function extractedRecipesForSkill(skill) {
  const all = loadExtractedRecipes();
  return all[String(skill).toLowerCase()] ?? [];
}

export function extractedRecipeSkills() {
  return Object.keys(loadExtractedRecipes()).sort();
}

/**
 * Total recipe count across all skills. Used for diagnostics and the
 * `[recipes` command summary line.
 */
export function extractedRecipeCount() {
  const all = loadExtractedRecipes();
  return Object.values(all).reduce((n, arr) => n + (arr?.length ?? 0), 0);
}
