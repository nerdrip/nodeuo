// `[signgen` / `[signdelete` — bulk-place every entry in `signs.json`
// (extracted from `templates/ServUO/Data/signs.cfg`) on Felucca + Trammel.
// Mirrors ServUO `SignParser.cs` + `SignGenDelete.cs`.
//
// Each sign carries `labelNumber` (cliloc id) so the client can read its
// real "<Britain Bank>" / "<Magincia Reagent Shop>" name via the OPL flow.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { allItems } from '../../_spatial.js';
import { createItem, destroyItemBySerial } from '../../_items.js';
import { queueBulkSave, refreshBulkVisibility } from '../_bulk-broadcast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin → commands → src, then data/world/.
const SIGNS_PATH = resolve(__dirname, '..', '..', 'data', 'world', 'signs.json');

let _cache = null;
function loadCatalog() {
  if (_cache) return _cache;
  if (!existsSync(SIGNS_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(SIGNS_PATH, 'utf8'));
    _cache = remapLegacyShape(raw).map((entry) => {
      // The extracted Tanner sign at Royal City used ServUO's historic
      // internal map ordinal 6. Our web shard exposes Ter Mur as facet 5.
      if ((entry.map | 0) === 6 && (entry.x | 0) === 812 && (entry.y | 0) === 3389) {
        return { ...entry, map: 5 };
      }
      return entry;
    });
  } catch (e) { console.warn('[signgen] read failed', e.message); _cache = []; }
  return _cache;
}

/**
 * Detect + repair the old broken signs.json shape produced by the
 * pre-2026-05-11 extractor. That extractor parsed columns shifted by
 * one — every entry had `itemId: 0` and the real itemId leaked into
 * `x`. Without re-running extraction, fix at load time:
 *
 *   old: { itemId: 0, x: 3032, y: 373, z: 904, hue: -1, labelNumber, map }
 *   new: { itemId: 3032, x: 373, y: 904, z: -1, hue: 0, labelNumber, map }
 *
 * `hue: -1` is also a legacy junk value (no hue column in ServUO);
 * treat as 0. New extractor output already follows the canonical
 * shape so this is a no-op for fresh dumps.
 */
function remapLegacyShape(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const sample = arr[0];
  const looksBroken = (sample.itemId === 0) && Number.isFinite(sample.x) && sample.x > 1000;
  if (!looksBroken) return arr;
  console.warn(`[signgen] detected legacy column-shifted signs.json — remapping ${arr.length} entries`);
  return arr.map((e) => ({
    type: e.type ?? 'Sign',
    itemId: e.x | 0,
    x: e.y | 0,
    y: e.z | 0,
    z: e.hue | 0,
    hue: 0,
    labelNumber: e.labelNumber,
    map: e.map,
  }));
}

// ServUO signs.cfg drops `itemId: 0` for entries where the C# source
// pulls the graphic from the parent Sign subclass at runtime
// (NSWoodSign, HangingShingle, BoneSign, …). Without substituting a
// real graphic the placed item is invisible. Use a sensible default:
//   - 0x0BD8 = NW-facing wooden sign (canonical "shop sign" art)
//   - hue forced to 0 if the catalog stamped -1 (mojibake from extract)
const DEFAULT_SIGN_GRAPHIC = 0x0BD8;

function pickSignGraphic(entry) {
  if (entry.itemId && entry.itemId > 0) return entry.itemId;
  return DEFAULT_SIGN_GRAPHIC;
}

function signKey({ map, x, y, z, itemId, labelNumber, name }) {
  return `${map | 0}:${x | 0}:${y | 0}:${z | 0}:${pickSignGraphic({ itemId }) | 0}:` +
    `${labelNumber | 0}:${String(name ?? '')}`;
}

export function applySigns(api, opts = {}) {
  const catalog = loadCatalog();
  if (!catalog.length) return { added: 0 };
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  if (!world._signsApplied) world._signsApplied = new Set();
  // Per-placement idempotency self-heals a partially generated or manually
  // edited facet. A facet-wide flag used to skip every missing sign as soon
  // as one earlier pass had completed.
  const existingKeys = new Set();
  const invalidLegacySigns = [];
  for (const it of allItems({ world })) {
    if (it.script !== 'sign' || !it.isDecoration) continue;
    if ((it.map | 0) === 6 && (it.x | 0) === 812 && (it.y | 0) === 3389) {
      invalidLegacySigns.push(it.serial);
      continue;
    }
    existingKeys.add(signKey(it));
  }
  for (const serial of invalidLegacySigns) destroyItemBySerial(api, serial);
  let added = 0; let skipped = 0; let failed = 0;
  for (const e of catalog) {
    if (wantFacets && !wantFacets.has(e.map)) continue;
    if ((e.map | 0) < 0 || (e.map | 0) > 5) {
      failed++;
      api.log?.(`[signgen] invalid facet ${e.map} at (${e.x},${e.y},${e.z})`);
      continue;
    }
    const key = signKey(e);
    if (existingKeys.has(key)) { skipped++; continue; }
    let item;
    try {
      item = createItem(api, world, {
        itemId: pickSignGraphic(e),
        hue: (e.hue && e.hue > 0) ? e.hue : 0,
        x: e.x, y: e.y, z: e.z, map: e.map,
        name: e.name,
        movable: false,
      });
    } catch (err) {
      failed++;
      if (failed <= 3) api.log?.(`[signgen] create failed: ${err.message}`);
      continue;
    }
    item.isDecoration = true;
    item.script = 'sign';
    if (e.labelNumber) item.labelNumber = e.labelNumber;
    existingKeys.add(key);
    added++;
  }
  if (wantFacets) for (const f of wantFacets) world._signsApplied.add(f);
  else for (const e of catalog) world._signsApplied.add(e.map);
  return { added, skipped, failed };
}

export function deleteSigns(api, opts = {}) {
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  let removed = 0;
  const victims = [];
  for (const it of allItems({ world })) {
    if (it.script !== 'sign') continue;
    if (!it.isDecoration) continue;
    if (wantFacets && !wantFacets.has(it.map)) continue;
    victims.push(it.serial);
  }
  for (const s of victims) { destroyItemBySerial(api, s); removed++; }
  if (wantFacets) for (const f of wantFacets) world._signsApplied?.delete(f);
  else world._signsApplied?.clear();
  return { removed };
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};
  api.commands.register({
    name: 'signgen',
    help: '[signgen — place every world sign from signs.cfg.',
    access: 'Admin',
    run(ctx) {
      const r = applySigns(api);
      const refreshed = refreshBulkVisibility(api);
      queueBulkSave(api);
      ctx.state.sendSystemMessage(`SignGen: ${r.added} signs placed, ${r.skipped} unchanged. Refreshed clients: ${refreshed}.`);
    },
  });
  api.commands.register({
    name: 'signdelete',
    help: '[signdelete — remove signgen-placed signs.',
    access: 'Admin',
    run(ctx) {
      const r = deleteSigns(api);
      const refreshed = refreshBulkVisibility(api);
      queueBulkSave(api);
      ctx.state.sendSystemMessage(`SignDelete: ${r.removed} signs removed. Refreshed clients: ${refreshed}.`);
    },
  });
  return () => {};
}
