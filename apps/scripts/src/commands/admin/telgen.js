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
import { queueBulkSave, refreshBulkVisibility } from '../_bulk-broadcast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin → commands → src, then data/world/. Single-`..` left this at
// `commands/data/...` which never existed.
const TELE_PATH = resolve(__dirname, '..', '..', 'data', 'world', 'teleporters.json');
const TELE_GRAPHIC = 0x1BCB; // canonical invisible floor trigger
const LEGACY_VISIBLE_TELE_GRAPHIC = 0x1BC3;

let _cache = null;
function loadCatalog() {
  if (_cache) return _cache;
  if (!existsSync(TELE_PATH)) return [];
  try { _cache = JSON.parse(readFileSync(TELE_PATH, 'utf8')); }
  catch (e) { console.warn('[telgen] read failed', e.message); _cache = []; }
  return _cache;
}

const teleKey = ({ map, x, y, z, teleportTo, destX, destY, destZ, destMap }) => {
  const d = teleportTo ?? { x: destX, y: destY, z: destZ, map: destMap };
  return `${map | 0}:${x | 0}:${y | 0}:${z | 0}>${d.map | 0}:${d.x | 0}:${d.y | 0}:${d.z | 0}`;
};

/** Upgrade old telgen decorations without touching intentionally visible
 * spell gates or custom GM teleporters. */
export function repairGeneratedTeleporters(api) {
  const existingKeys = new Set();
  let repaired = 0;
  for (const it of allItems({ world: api.world })) {
    if (it.script !== 'teleporter' || !it.isDecoration) continue;
    let changed = false;
    if (it.visible !== false) { it.visible = false; changed = true; }
    if ((it.itemId | 0) === LEGACY_VISIBLE_TELE_GRAPHIC) {
      it.itemId = TELE_GRAPHIC;
      changed = true;
    }
    if (changed) repaired++;
    existingKeys.add(teleKey(it));
  }
  return { repaired, existingKeys };
}

export function applyTeleporters(api, opts = {}) {
  const catalog = loadCatalog();
  if (!catalog.length) return { added: 0, skipped: 0, failed: 0, repaired: 0 };
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  if (!world._telesApplied) world._telesApplied = new Set();
  const { repaired, existingKeys } = repairGeneratedTeleporters(api);
  let added = 0; let skipped = 0; let failed = 0;
  for (const e of catalog) {
    if (wantFacets && !wantFacets.has(e.map)) continue;
    const key = teleKey(e);
    if (existingKeys.has(key)) { skipped++; continue; }
    if ((e.map | 0) < 0 || (e.map | 0) > 5 || (e.destMap | 0) < 0 || (e.destMap | 0) > 5) {
      failed++;
      continue;
    }
    let item;
    try {
      item = createItem(api, world, {
        itemId: TELE_GRAPHIC, hue: 0,
        x: e.x, y: e.y, z: e.z, map: e.map,
        movable: false, visible: false,
      });
    } catch (err) {
      failed++;
      if (failed <= 3) api.log?.(`[telgen] create failed: ${err.message}`);
      continue;
    }
    item.isDecoration = true;
    item.script = 'teleporter';
    item.teleportTo = { x: e.destX, y: e.destY, z: e.destZ, map: e.destMap };
    item.creatures = false;
    existingKeys.add(key);
    added++;
  }
  if (wantFacets) for (const f of wantFacets) world._telesApplied.add(f);
  else for (const e of catalog) world._telesApplied.add(e.map);
  return { added, skipped, failed, repaired };
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
  // Persistence is restored before scripts are registered. Repair legacy
  // anchors on every startup/hot reload so an existing shard does not need
  // an explicit [telgen invocation to lose the visible floor markers.
  const startupRepair = repairGeneratedTeleporters(api);
  if (startupRepair.repaired > 0) {
    queueBulkSave(api);
    const refresh = () => refreshBulkVisibility(api);
    if (api.lifecycle?.setImmediate) api.lifecycle.setImmediate(refresh);
    else setImmediate(refresh);
    api.log?.(`[telgen] repaired ${startupRepair.repaired} visible teleporter anchor(s)`);
  }
  api.commands.register({
    name: 'telgen',
    help: '[telgen — place every teleporter pad from teleporters.csv (1374 records, 5 facets).',
    access: 'Admin',
    run(ctx) {
      const r = applyTeleporters(api);
      const refreshed = refreshBulkVisibility(api);
      queueBulkSave(api);
      ctx.state.sendSystemMessage(`TelGen: ${r.added} placed, ${r.repaired} repaired, ${r.skipped} unchanged, ${r.failed} failed. Refreshed clients: ${refreshed}.`);
    },
  });
  api.commands.register({
    name: 'teldelete',
    help: '[teldelete — remove telgen-placed teleporters.',
    access: 'Admin',
    run(ctx) {
      const r = deleteTeleporters(api);
      const refreshed = refreshBulkVisibility(api);
      queueBulkSave(api);
      ctx.state.sendSystemMessage(`TelDelete: ${r.removed} teleporters removed. Refreshed clients: ${refreshed}.`);
    },
  });
  return () => {};
}
