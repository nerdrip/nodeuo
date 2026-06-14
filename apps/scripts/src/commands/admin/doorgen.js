// `[doorgen` / `[doorgendelete` — bulk-place doors that the decoration
// extractor flagged as the `door` script. Mirrors ServUO `DoorGenerator.cs`.
//
// We *also* populate doors by walking the decoration catalog at the entries
// whose `type` matches a known door class. Re-runs are idempotent: the
// underlying decoration command already tracks which facets are applied;
// running [doorgen alone is useful when [decorate was skipped but the
// player wants doors in town gates / dungeon entrances.
//
// Each placed item is wired so the existing item-script `door` (lives in
// apps/scripts/src/items/scripts/world/door.js — handles open/close on
// double-click and auto-close timer) takes over on use.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { allItems, onlineMobiles } from '../../_spatial.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin → commands → src, then data/world/. Single-`..` left this at
// `commands/data/...` which never existed.
const DECO_PATH = resolve(__dirname, '..', '..', 'data', 'world', 'decorations.json');

const DOOR_RX = /(door|gate|portcullis)/i;

function looksLikeDoor(type) {
  return typeof type === 'string' && DOOR_RX.test(type);
}

function loadDoorEntries() {
  if (!existsSync(DECO_PATH)) return [];
  try {
    const all = JSON.parse(readFileSync(DECO_PATH, 'utf8'));
    return all.filter((e) => looksLikeDoor(e.type));
  } catch (e) { console.warn('[doorgen] read failed', e.message); return []; }
}

function doorKey({ map, x, y, z, itemId, door }) {
  const closedId = door?.closedId ?? itemId;
  return `${map | 0}:${x | 0}:${y | 0}:${z | 0}:${closedId | 0}`;
}

export function applyDoors(api, opts = {}) {
  const entries = loadDoorEntries();
  if (!entries.length) {
    api.log?.(`[doorgen] no door entries in decorations.json (path: ${DECO_PATH})`);
    return { added: 0 };
  }
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  if (!world._doorsApplied) world._doorsApplied = new Set();
  // Self-heal: index existing generated doors so re-runs fill only the
  // missing entries. Older code marked a whole facet as applied when it
  // found a single saved door, which left towns without doors after a
  // partial wipe / restart.
  const existingKeys = new Set();
  for (const it of allItems({ world })) {
    if (it.script !== 'door' || !it.isDecoration) continue;
    existingKeys.add(doorKey(it));
  }
  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of entries) {
    if (wantFacets && !wantFacets.has(e.map)) { skipped++; continue; }
    const key = doorKey(e);
    if (existingKeys.has(key)) { skipped++; continue; }
    let item;
    try {
      item = createItem(api, world, {
        itemId: e.itemId, hue: e.hue ?? 0,
        x: e.x, y: e.y, z: e.z, map: e.map,
        movable: false,
      });
    } catch (err) {
      failed++;
      if (failed <= 3) api.log?.(`[doorgen] createItem failed at (${e.x},${e.y},${e.z}) map=${e.map}: ${err.message}`);
      continue;
    }
    item.isDecoration = true;
    item.script = 'door';
    // Stamp `item.door` AT PLACEMENT so the runtime collision path
    // (`movement.js::runtimeSolidAt` yields `it.door || it.solid`)
    // blocks walk-through immediately, AND so the door hook in
    // `commands/door.js` can swap closed↔open art on toggle without
    // a per-click housedata lookup.
    //
    // Open = closedId + 1. UO convention: every door art lives as a
    // contiguous (closed, open) pair within an 8-piece run that
    // covers 4 facings × 2 hinges = 8 closed/open pairs (16 ids).
    // Earlier we tried housedata.doorCategoryPieces[] but that array
    // stores the 8 CLOSED variants in facing/hinge order — its index
    // toggle (i ^ 1) hopped to the next FACING, not to the OPEN of
    // the same door. Marcin reported door 0x0675 toggling to 0x0677
    // (closed-east) instead of 0x0676 (open-south) — that was this
    // bug. Sticking to the simple +1 convention is correct for every
    // door variant in the standard UO art.
    item.door = {
      closedId: e.itemId,
      openId: e.itemId + 1,
      isOpen: false,
      facing: e.facing ?? null,
    };
    if (e.facing) item.decoFacing = e.facing;
    existingKeys.add(key);
    added++;
  }
  if (wantFacets) for (const f of wantFacets) world._doorsApplied.add(f);
  else for (const e of entries) world._doorsApplied.add(e.map);
  if (skipped || failed) {
    api.log?.(`[doorgen] +${added} (skipped=${skipped}, failed=${failed}, total=${entries.length})`);
  }
  return { added };
}

export function deleteDoors(api, opts = {}) {
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  let removed = 0;
  const victims = [];
  for (const it of allItems({ world })) {
    if (it.script !== 'door' || !it.isDecoration) continue;
    if (wantFacets && !wantFacets.has(it.map)) continue;
    victims.push(it.serial);
  }
  for (const s of victims) { destroyItemBySerial(api, s); removed++; }
  if (wantFacets) for (const f of wantFacets) world._doorsApplied?.delete(f);
  else world._doorsApplied?.clear();
  return { removed };
}

function refreshOnlineClients(api) {
  const refresh = api.ctx?.handlers?.refreshSurroundings;
  if (typeof refresh !== 'function') return 0;
  let count = 0;
  for (const mob of onlineMobiles(api)) {
    if (!mob?.client) continue;
    try {
      refresh(mob.client);
      count++;
    } catch (e) {
      api.log?.(`[doorgen] refresh client failed: ${e.message}`);
    }
  }
  return count;
}

function queueSave(api) {
  try {
    api.persistence?.requestSave?.(api.world, api.persistence.saveDir);
  } catch (e) {
    api.log?.(`[doorgen] save queue failed: ${e.message}`);
  }
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};
  api.commands.register({
    name: 'doorgen',
    help: '[doorgen — place every door / gate / portcullis from the decoration catalog.',
    access: 'Admin',
    run(ctx) {
      const r = applyDoors(api);
      const refreshed = refreshOnlineClients(api);
      queueSave(api);
      ctx.state.sendSystemMessage(`DoorGen: ${r.added} doors placed. Refreshed clients: ${refreshed}.`);
    },
  });
  api.commands.register({
    name: 'doorgendelete',
    help: '[doorgendelete — remove every doorgen-placed door.',
    access: 'Admin',
    run(ctx) {
      const r = deleteDoors(api);
      const refreshed = refreshOnlineClients(api);
      queueSave(api);
      ctx.state.sendSystemMessage(`DoorGenDelete: ${r.removed} doors removed. Refreshed clients: ${refreshed}.`);
    },
  });
  return () => {};
}
