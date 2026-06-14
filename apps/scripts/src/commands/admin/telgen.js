// `[telgen` / `[teldelete` — bulk-place every entry in `teleporters.json`
// (extracted from `templates/ServUO/Data/teleporters.csv`) across all 5
// facets. 1374 records cover dungeon entrances, public moongates, region
// transitions, and the SA/TerMur stargates.
//
// One CSV row = one teleporter at (x,y,z,map) → (destX,destY,destZ,destMap).
// When `back` is true ServUO would create the reverse pad too, but the
// CSV already lists each direction as a separate row, so we just place
// the forward row and trust the data.
//
// Each item gets `script: 'teleporter'` + `teleportTo` so the existing
// teleporter lifecycle (apps/scripts/src/items/scripts/world/teleporter.js)
// already handles cross-facet transfer including 0xBF 0x08 emit.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { allItems } from '../../_spatial.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin → commands → src, then data/world/. Single-`..` left this at
// `commands/data/...` which never existed.
const TELE_PATH = resolve(__dirname, '..', '..', 'data', 'world', 'teleporters.json');
const TELE_GRAPHIC = 0x1BC3; // moongate-tile graphic (matches GenTeleporter.cs)

let _cache = null;
function loadCatalog() {
  if (_cache) return _cache;
  if (!existsSync(TELE_PATH)) return [];
  try { _cache = JSON.parse(readFileSync(TELE_PATH, 'utf8')); }
  catch (e) { console.warn('[telgen] read failed', e.message); _cache = []; }
  return _cache;
}

export function applyTeleporters(api, opts = {}) {
  const catalog = loadCatalog();
  if (!catalog.length) return { added: 0 };
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  if (!world._telesApplied) world._telesApplied = new Set();
  let added = 0;
  for (const e of catalog) {
    if (wantFacets && !wantFacets.has(e.map)) continue;
    if (world._telesApplied.has(e.map)) continue;
    const item = createItem(api, world, {
      itemId: TELE_GRAPHIC, hue: 0,
      x: e.x, y: e.y, z: e.z, map: e.map,
      movable: false,
    });
    item.isDecoration = true;
    item.script = 'teleporter';
    item.teleportTo = { x: e.destX, y: e.destY, z: e.destZ, map: e.destMap };
    item.creatures = false;
    added++;
  }
  if (wantFacets) for (const f of wantFacets) world._telesApplied.add(f);
  else for (const e of catalog) world._telesApplied.add(e.map);
  return { added };
}

export function deleteTeleporters(api, opts = {}) {
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  let removed = 0;
  const victims = [];
  for (const it of allItems({ world })) {
    if (it.script !== 'teleporter' || !it.isDecoration) continue;
    if (wantFacets && !wantFacets.has(it.map)) continue;
    victims.push(it.serial);
  }
  for (const s of victims) { destroyItemBySerial(api, s); removed++; }
  if (wantFacets) for (const f of wantFacets) world._telesApplied?.delete(f);
  else world._telesApplied?.clear();
  return { removed };
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};
  api.commands.register({
    name: 'telgen',
    help: '[telgen — place every teleporter pad from teleporters.csv (1374 records, 5 facets).',
    access: 'Admin',
    run(ctx) {
      const r = applyTeleporters(api);
      ctx.state.sendSystemMessage(`TelGen: ${r.added} teleporters placed.`);
    },
  });
  api.commands.register({
    name: 'teldelete',
    help: '[teldelete — remove telgen-placed teleporters.',
    access: 'Admin',
    run(ctx) {
      const r = deleteTeleporters(api);
      ctx.state.sendSystemMessage(`TelDelete: ${r.removed} teleporters removed.`);
    },
  });
  return () => {};
}
