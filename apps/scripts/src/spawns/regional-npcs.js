// Regional named NPCs — placed by `[createworld` as the NPC stage.
//
// Reads `apps/scripts/src/data/world/regional-npcs.json` (~141 canon named
// characters: Britain's banker, Trinsic's paladin captain, Yew's
// abbey monks, …) and spawns each at a deterministic spot inside its
// region.
//
// Coordinates: most entries don't carry explicit (x, y, map). We derive
// them from REGION_ANCHOR (canonical town centre) plus a per-id offset
// computed with mulberry32 keyed on the id's hash so the layout is
// stable across runs but spread enough to not stack everyone on one
// tile.
//
// An entry MAY pin itself by adding an explicit `locations: [{ x, y, z,
// map }]` array — useful for famous landmarks like Lord British's throne
// or the Britain Sewers entrance.
//
// Idempotency: each NPC carries `_regionalId = entry.id` so re-runs
// skip slots that already have the right NPC.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { resolveStandingZ } from '../_movement.js';
import { allMobiles } from '../_spatial.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/regional-npcs.json');

const TRAMMEL = 1;

/** Region → anchor (x, y, map). User decision 2026-05-18: Trammel is the
 *  main-gameplay facet of this shard. Felucca exists in the map data but
 *  is intentionally not populated (no NPCs, no moongate destinations) —
 *  ServUO mirrors town vendors on both facets, but our shard treats
 *  Felucca as a dead facet so we save the spawn cost. Each region
 *  resolves to a SINGLE facet here. */
const REGION_ANCHOR = {
  britain:        { x: 1495, y: 1635, map: TRAMMEL },
  trinsic:        { x: 1862, y: 2790, map: TRAMMEL },
  vesper:         { x: 2875, y:  700, map: TRAMMEL },
  minoc:          { x: 2485, y:  470, map: TRAMMEL },
  yew:            { x:  643, y:  855, map: TRAMMEL },
  magincia:       { x: 3712, y: 2120, map: TRAMMEL },
  skara:          { x:  585, y: 2200, map: TRAMMEL },
  'skara-brae':   { x:  585, y: 2200, map: TRAMMEL },
  jhelom:         { x: 1373, y: 3823, map: TRAMMEL },
  moonglow:       { x: 4408, y: 1050, map: TRAMMEL },
  cove:           { x: 2244, y: 1198, map: TRAMMEL },
  'bucs-den':     { x: 2734, y: 2107, map: TRAMMEL },
  buccs:          { x: 2734, y: 2107, map: TRAMMEL },
  nujelm:         { x: 3771, y: 1296, map: TRAMMEL },
  "nujel'm":      { x: 3771, y: 1296, map: TRAMMEL },
  occlo:          { x: 3652, y: 2660, map: TRAMMEL },
  'serpents-hold':{ x: 2903, y: 3475, map: TRAMMEL },
  shold:          { x: 2903, y: 3475, map: TRAMMEL },
  papua:          { x: 5742, y: 3212, map: TRAMMEL },
  delucia:        { x: 5276, y: 3990, map: TRAMMEL },
  wind:           { x: 5169, y:   18, map: TRAMMEL },
  haven:          { x: 3503, y: 2575, map: TRAMMEL },
  'new-haven':    { x: 3503, y: 2575, map: TRAMMEL },
  'new-magincia': { x: 3724, y: 2167, map: TRAMMEL },
  lakeshire:      { x:  590, y: 1990, map: TRAMMEL },
  'royal-city':   { x:  769, y: 3469, map: 5 },                   // TerMur
  termur:         { x:  769, y: 3469, map: 5 },
  ter_mur:        { x:  769, y: 3469, map: 5 },
  'ter-mur':      { x:  769, y: 3469, map: 5 },
  tokuno:         { x:  802, y:  478, map: 4 },                   // Zento (Tokuno facet)
  zento:          { x:  802, y:  478, map: 4 },
  eodon:          { x:  725, y: 1838, map: 5 },                   // Eodon shares TerMur facet id
};

/** mulberry32 keyed on the id hash → repeatable offset. */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function pickPos(entry) {
  if (Array.isArray(entry.locations) && entry.locations.length) {
    return entry.locations[0];
  }
  const anchor = REGION_ANCHOR[entry.region] ?? REGION_ANCHOR.britain;
  const rng = mulberry32(djb2(entry.id || entry.name));
  const dx = Math.floor(rng() * 11) - 5;     // ±5 tile spread
  const dy = Math.floor(rng() * 11) - 5;
  return { x: anchor.x + dx, y: anchor.y + dy, map: anchor.map };
}

function alreadyPlaced(world, entry, pos) {
  for (const m of allMobiles({ world })) {
    if (m._regionalId === entry.id) return true;
    if (m.map !== (pos.map ?? 1)) continue;
    if (m.name !== entry.name) continue;
    if (Math.abs(m.x - pos.x) > 6) continue;
    if (Math.abs(m.y - pos.y) > 6) continue;
    return true;
  }
  return false;
}

/** Public: spawn every regional NPC. Idempotent; safe to call from
 *  [createworld and at script load. Returns `{ placed, skipped, errors }`. */
export function placeRegionalNpcs(api, entries = null) {
  if (!api.vendors?.spawnAt) {
    return { placed: 0, skipped: 0, errors: ['vendors.spawnAt unavailable'] };
  }
  let list = entries;
  if (!Array.isArray(list)) {
    try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
    catch (e) { return { placed: 0, skipped: 0, errors: [e.message] }; }
  }

  const out = { placed: 0, skipped: 0, errors: [] };
  for (const entry of list) {
    const pos = pickPos(entry);
    // Snap to walkable z. createMobile defaults to caller's z, but
    // banks / abbey floors / pagodas live above land level.
    let z = pos.z ?? 0;
    try {
      const standZ = resolveStandingZ(api, pos.map ?? 1, pos.x, pos.y, 0);
      if (Number.isFinite(standZ)) z = standZ;
    } catch { /* fall back to provided z */ }
    const target = { x: pos.x, y: pos.y, z, map: pos.map ?? 1,
                     name: entry.name, title: entry.title };
    if (alreadyPlaced(api.world, entry, target)) { out.skipped++; continue; }

    // Fall back to a generic vendorKind when entry omits it (NPC is
    // ambient flavor — pacing the streets, no shop). `wanderer` is the
    // default "innocent civilian" kind in vendor.js VENDOR_KINDS.
    const kindKey = entry.vendorKind || 'wanderer';
    const mob = api.vendors.spawnAt(kindKey, target);
    if (!mob) {
      // Unknown vendorKind — fall back to a generic citizen via the
      // peace-NPC helper so the name still lands in the world.
      const spawnNPC = api.spawnNPC ?? null;
      if (spawnNPC) {
        const m2 = spawnNPC(api, target, {
          name: entry.name, body: entry.body, hue: entry.hue,
          notoriety: 1, invulnerable: true,
        });
        if (m2) {
          m2._regionalId = entry.id;
          out.placed++;
          continue;
        }
      }
      out.errors.push(`${entry.id}: spawn failed (kind=${kindKey})`);
      continue;
    }
    mob._regionalId = entry.id;
    if (entry.hue != null) mob.hue = entry.hue;
    out.placed++;
  }
  return out;
}

export default function register(api) {
  if (!api.vendors?.spawnAt) {
    api.log?.('spawn/regional-npcs: vendors.spawnAt unavailable, deferring');
    return () => {};
  }
  // Expose for `[createworld` stage hook to reach.
  api.regionalNpcs = { place: () => placeRegionalNpcs(api) };
  // A cold world creates ~141 NPCs and several hundred worn items. Doing all
  // of that inside the script initializer made startup depend on single-core
  // speed (roughly 200-450 ms) and could trip the runtime's 250 ms safety
  // budget. Populate in small event-loop slices: the listener becomes ready
  // immediately and no first client sees a half-second main-thread stall.
  let list;
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) {
    api.log?.(`spawn/regional-npcs: ${e.message}`);
    return () => {};
  }
  const total = { placed: 0, skipped: 0, errors: [] };
  let cursor = 0;
  const schedule = api.lifecycle?.setImmediate ?? setImmediate;
  const populateSlice = () => {
    const slice = list.slice(cursor, cursor + 12);
    cursor += slice.length;
    const result = placeRegionalNpcs(api, slice);
    total.placed += result.placed;
    total.skipped += result.skipped;
    total.errors.push(...result.errors);
    if (cursor < list.length) {
      schedule(populateSlice);
      return;
    }
    api.log?.(`spawn/regional-npcs: placed ${total.placed}, skipped ${total.skipped}` +
      (total.errors.length ? `, ${total.errors.length} error(s)` : ''));
  };
  schedule(populateSlice);
  return () => { /* mobs persist by design */ };
}
