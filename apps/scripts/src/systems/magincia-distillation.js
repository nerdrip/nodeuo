// Magincia distillation loader — pushes the recipe table from
// scripts/data/config/magincia-recipes.json into the server engine.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/config/magincia-recipes.json');

export default function register(api) {
  const sys = api.systems?.maginciaDistillation;
  if (!sys?.setRecipes) {
    api.log?.('magincia-distillation: engine API missing, skipping');
    return () => {};
  }
  let json = { recipes: {} };
  try { json = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`magincia-distillation: ${e.message}`); return () => {}; }
  // JSON keys come back as strings; engine expects numeric keys.
  const numeric = {};
  for (const [k, v] of Object.entries(json.recipes ?? {})) numeric[+k] = v;
  sys.setRecipes(numeric);
  api.log?.(`magincia-distillation: loaded ${Object.keys(numeric).length} recipes`);
  return () => sys.setRecipes({});
}
