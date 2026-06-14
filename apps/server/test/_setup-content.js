// Test setup helper — invokes the scripts that register spells, recipes,
// items and mobs so tests can call `getSpell(id)`, `getRecipe(id)`, etc.
// against a fully-populated registry. Mirrors what the script runtime
// does at server boot.

import * as itemsReg from '../src/content/items/registry.js';
import * as spellSys from '../src/systems/spells/index.js';
import * as craftSys from '../src/systems/crafting/index.js';
import * as poison from '../src/poison.js';
import * as combat from '../src/combat-formulas.js';
import * as spellweaving from '../src/systems/spellweaving.js';

/** Minimal api stub passed to script `register(api)` calls. */
export function makeTestApi(extra = {}) {
  return {
    catalog: { items: itemsReg },
    systems: {
      spells: spellSys,
      crafting: craftSys,
      spellweaving,
      ...(extra.systems ?? {}),
    },
    poison,
    combat,
    log: () => {},
    ...extra,
  };
}

let _loaded = false;

/** Idempotent loader — invokes all spell schools and reagents.
 *
 *  Every spell (Magery, Necromancy, Chivalry, Bushido, Ninjitsu,
 *  Mysticism, Spellweaving, Mastery, Bard-Mastery, Gargoyle) funnels
 *  through `spells/index.js` — single registration loop driven by
 *  data/config/spells.json. The `schools/` directory was deleted
 *  entirely 2026-05-17 after every legacy stub was extracted into
 *  per-spell .js files. */
export async function loadSpells() {
  if (_loaded) return;
  const api = makeTestApi();
  await (await import('../../scripts/src/spells/index.js')).default(api);
  await (await import('../../scripts/src/spells/reagents.js')).default(api);
  _loaded = true;
}

/** Load crafting schools (alchemy, blacksmithing, …). */
let _craftLoaded = false;
export async function loadCrafting() {
  if (_craftLoaded) return;
  const api = makeTestApi();
  for (const school of [
    'alchemy', 'blacksmithing', 'carpentry', 'cartography', 'cooking',
    'fletching', 'glassblowing', 'inscription', 'masonry', 'tailoring', 'tinkering',
  ]) {
    await (await import(`../../scripts/src/crafting/${school}.js`)).default(api);
  }
  _craftLoaded = true;
}

/** Load loot packs. */
let _lootLoaded = false;
export async function loadLootPacks(lootRegistry) {
  if (_lootLoaded) return;
  const api = makeTestApi({ loot: lootRegistry });
  await (await import('../../scripts/src/items/loaders/loot-packs.js')).default(api);
  _lootLoaded = true;
}
