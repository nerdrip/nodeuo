// Public moongate spawner — multi-facet. Mirrors ServUO `Scripts/Items/
// Functional/PublicMoongate.cs::PMList`. Using one opens an inline
// destination-picker (see public-moongate item-script).
//
// Facet networks (user decision 2026-05-18: Trammel is main facet,
// Felucca intentionally left empty so ServUO-canonical Felucca network
// is NOT spawned even though the gate art is referenced for reference
// in the JSON _comment):
//   Trammel  (1)  — 9 gates (Moonglow, Britain, Jhelom, Yew, Minoc,
//                  Trinsic, Skara Brae, New Magincia, New Haven)
//   Ilshenar (2)  — 9 gates (8 virtue shrines + Chaos)
//   Malas    (3)  — 2 gates (Luna, Umbra)
//   Tokuno   (4)  — 3 gates (Isamu-Jima, Makoto-Jima, Homare-Jima)
//   TerMur   (5)  — 2 gates (Royal City, Valley of Eodon)
//
// Routing is WITHIN-FACET only (a Trammel moongate teleports to a
// Trammel destination). ServUO's PublicMoongate.cs supports cross-
// facet via the full PMList[] but that's left for a future pass.
//
// Layered as a `[createworld` stage too — `applyMoongates` / `deleteMoongates`
// are exported so the bulk loader can include them with the rest of the
// generated content.

// Network data lives in `data/world/spawns/moongates.json` — one entry
// per facet with its graphic + per-gate coords. Edit the JSON to add a
// gate or change a facet's graphic.
import fs from 'node:fs';
import path from 'node:path';
import { moveItem } from '../_movement.js';
import url from 'node:url';
import { allItems } from '../_spatial.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';

const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/moongates.json');

let FACET_GATES = [];
try {
  const cfg = JSON.parse(fs.readFileSync(__DATA, 'utf8'));
  FACET_GATES = (cfg.facets ?? []).map((f) => ({
    map: f.map, graphic: f.graphic, gates: f.gates,
  }));
} catch (e) {
  console.warn('[moongates] data load failed:', e.message);
}

/** Flat catalogue exported so other modules (e.g. the `[go` command) can
 *  surface every moongate location as a teleport destination without
 *  duplicating the table. */
export const MOONGATE_LOCATIONS = FACET_GATES.flatMap((f) =>
  f.gates.map((g) => ({ ...g, map: f.map, graphic: f.graphic })),
);

/**
 * Idempotent bulk apply. The world tracks which facets have already been
 * populated on `world._moongatesApplied` so re-running `[createworld`
 * after a partial pass doesn't double up the gates.
 */
export function applyMoongates(api, opts = {}) {
  if (!api.world || !canCreateItem(api, api.world)) return { added: 0 };
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  if (!world._moongatesApplied) world._moongatesApplied = new Set();
  // Reconstruct the "applied" set from existing items — `_moongatesApplied`
  // is a runtime Set that doesn't survive save→load. Without this the
  // boot-time register() would re-create every moongate as a duplicate
  // beside the saved one.
  //
  // Three self-heal passes for legacy saves:
  //   1. Orphan-purge: delete moongates whose facet is no longer in the
  //      JSON spec (e.g. the old Felucca map=0 gates after Felucca was
  //      dropped from the network on 2026-05-18 per user decision).
  //   2. itemId/graphic refresh: stale graphic → canonical graphic.
  //   3. Position/network refresh: stale coords + gateNetwork get
  //      replaced with the JSON spec values, matching what the picker
  //      gump will offer.
  const orphans = [];
  const existingGateKeys = new Set();
  for (const it of allItems({ world })) {
    if (it.script !== 'public-moongate') continue;
    const facet = FACET_GATES.find((f) => f.map === (it.map | 0));
    if (!facet) {
      // Facet was dropped from the spec — delete the orphan instead of
      // re-attaching a dead network.
      orphans.push(it.serial);
      continue;
    }
    world._moongatesApplied.add(it.map | 0);
    if (!Array.isArray(it.gateNetwork) || it.gateNetwork.length !== facet.gates.length) {
      it.gateNetwork = facet.gates;
      it.gateFacet = facet.map;
    } else {
      // Detect a coord drift on any single entry — if any destination
      // moved (e.g. Britain z=2 → z=5 in the ServUO sync) the whole
      // table is out of date; swap it wholesale.
      const drifted = facet.gates.some((g, i) => {
        const cur = it.gateNetwork[i];
        return !cur || cur.x !== g.x || cur.y !== g.y || cur.z !== g.z || cur.name !== g.name;
      });
      if (drifted) {
        it.gateNetwork = facet.gates;
        it.gateFacet = facet.map;
      }
    }
    if ((it.itemId | 0) !== (facet.graphic | 0)) {
      it.itemId = facet.graphic | 0;
      api.markers?.markItemDirty?.(it);
    }
    // If the gate item itself drifted away from its canonical anchor
    // (rare — only happens if someone hand-moved it via [edititem),
    // snap it back to the matching spec coords.
    const spec = facet.gates.find((g) => g.name === (it.name || '').replace(/^Public Moongate \(|\)$/g, ''));
    if (spec) existingGateKeys.add(`${facet.map}:${spec.name}`);
    if (spec && (it.x !== spec.x || it.y !== spec.y || it.z !== spec.z)) {
      moveItem(api, it, { x: spec.x, y: spec.y, z: spec.z, map: it.map });
      api.markers?.markItemDirty?.(it);
    }
  }
  for (const s of orphans) {
    try { destroyItemBySerial(api, s); }
    catch { /* gone */ }
  }
  if (orphans.length) api.log?.(`[moongates] purged ${orphans.length} orphans from dropped facets`);
  let added = 0; let skipped = 0; let failed = 0;
  for (const facet of FACET_GATES) {
    if (wantFacets && !wantFacets.has(facet.map)) continue;
    for (const g of facet.gates) {
      const key = `${facet.map}:${g.name}`;
      if (existingGateKeys.has(key)) { skipped++; continue; }
      try {
        const item = createItem(api, world, {
          itemId: facet.graphic,
          x: g.x, y: g.y, z: g.z, map: facet.map,
          name: `Public Moongate (${g.name})`,
          servuoClass: 'PublicMoongate',
          servuoClasses: ['PublicMoongate', 'PMEntry', 'PMList'],
          movable: false,
        });
        item.script = 'public-moongate';
        item.gateNetwork = facet.gates;
        item.gateFacet = facet.map;
        item.creatures = true;
        item.isDecoration = true;
        existingGateKeys.add(key);
        added++;
      } catch (e) {
        failed++;
        api.log?.(`moongate spawn failed (${g.name} @ map ${facet.map}): ${e.message}`);
      }
    }
    world._moongatesApplied.add(facet.map);
  }
  return { added, skipped, failed };
}

export function deleteMoongates(api, opts = {}) {
  if (!api.world) return { removed: 0 };
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  let removed = 0;
  const victims = [];
  for (const it of allItems({ world })) {
    if (it.script !== 'public-moongate') continue;
    if (wantFacets && !wantFacets.has(it.map)) continue;
    victims.push(it.serial);
  }
  for (const s of victims) {
    try { destroyItemBySerial(api, s); removed++; }
    catch { /* gone */ }
  }
  if (wantFacets) for (const f of wantFacets) world._moongatesApplied?.delete(f);
  else world._moongatesApplied?.clear();
  return { removed };
}

// Default registration: apply on script load so a fresh boot still has
// the gates without `[createworld`. Idempotency guard above prevents
// duplicates when both this register AND `[createworld` run in the same
// session.
export default function register(api) {
  const r = applyMoongates(api);
  if (r.added > 0) {
    api.log?.(`moongates: ${r.added} placed across ${FACET_GATES.length} facets`);
  }
  return () => deleteMoongates(api);
}
