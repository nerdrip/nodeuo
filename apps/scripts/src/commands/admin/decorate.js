// `[decorate` / `[decoratedelete` — admin command that materialises every
// entry in `apps/scripts/src/data/world/decorations.json` as an in-world item
// stamped `isDecoration = true`.
//
// Mirrors ServUO `Decorate.cs` (1416 lines): walks every facet folder,
// resolves the per-folder map id, and creates one Item per coord triplet.
// We pre-extracted the .cfg files into a single JSON catalog (107 951
// placements across 5 facets) so the runtime path is just a fast loop.
//
// Behaviour rules ported from Decorate.cs:
//   - decorations are immovable (`movable: false`)
//   - persistence skips them (they re-apply on every boot via this command)
//   - facets without source bins still materialise — server-side-only
//     decorations work even if the client hasn't extracted the facet bin
//   - re-running [decorate without [decoratedelete is a no-op (idempotent
//     guard checks the per-facet "applied" flag on the world)
//
// Door / sign / teleporter handling lives in dedicated commands; this one
// only places the bulk Static + furniture decorations and tags doors so
// the door command's hook-up runs. Cross-references in createworld.js.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { allItems } from '../../_spatial.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at apps/scripts/src/commands/admin/decorate.js — two
// levels up from `admin` lands at `src/`, then dive into `data/world/`.
// Prior code resolved with a single `..` (admin → commands) and looked
// for `commands/data/decorations.json` which never existed — every
// `[createworld` returned "Decorations: +0" because loadCatalog()'s
// existsSync gate failed and the function bailed before iterating.
const DECO_PATH = resolve(__dirname, '..', '..', 'data', 'world', 'decorations.json');

// Sentinel returned by `classifyType` for entries that another bulk
// command owns end-to-end (doorgen / signgen / telgen / moongate spawner).
// `applyDecorations` SKIPS these so we don't create a payload-less
// duplicate at the same coords — the user complaint was "nie wszędzie
// były drzwi, plus nie dało się ich tworzyć" which traced to decorate
// stamping ~2 100 doors as plain decorations BEFORE doorgen ran, leaving
// every gate as a non-interactive sprite half the time and a working
// door the other half (depending on which item the click hit first).
const DELEGATED = Symbol('delegated');

// Type → script binding. Most types fall back to plain decoration; only
// those that need behaviour (lights, containers) get a script string.
// Mirrors ServUO's class hierarchy at the broadest level — full per-class
// behaviour is out of scope for the bulk loader.
function classifyType(type, _itemId) {
  if (!type) return null;
  const t = type.toLowerCase();
  // Doors & gates (~30 distinct C# classes in ServUO). doorgen.js owns
  // these — it stamps the (closedId, openId, facing) payload that the
  // door use-handler needs. Skip here so we don't create a duplicate
  // sprite at the same tile.
  if (/(door|gate|portcullis)/.test(t)) return DELEGATED;
  // Signs likewise go through signgen.js (decorations.json carries 101
  // LocalizedSign entries; signs.json catalog has the canonical 868).
  if (t === 'sign' || t === 'localizedsign') return DELEGATED;
  // Teleporters and public moongates have dedicated apply functions
  // (telgen.js, spawns/moongates.js) — they wire the destination payload.
  if (/teleporter|moongate/.test(t)) return DELEGATED;
  // ServUO FillableContainer subclasses are not decorative-only: they
  // choose content from nearby vendor types and respawn after looting.
  if (/^fillable/.test(t) || t === 'librarybookcase') return 'fillable-container';
  // Lights / candles emit on. Bind 'light' so on-use toggles flame.
  if (/(candle|torch|lantern|lamp|sconce|brazier|firepit|fireplace)/.test(t)) return 'light';
  // Locked / non-locked containers. Furniture pieces opening into a
  // gump (chests, drawers, armoires).
  if (/(chest|crate|box|barrel|drawer|armoire|bookcase|cabinet|desk|secretchest|footlocker|coffer|sea chest)/.test(t)) {
    return 'container';
  }
  return null;
}

const CONTAINER_GUMPS = [
  [/fillablebarrel|barrel|keg/i, 0x003E],
  [/fillablelargecrate|largecrate|crate/i, 0x0044],
  [/fillablesmallcrate|smallcrate/i, 0x0044],
  [/fillablewoodenbox|woodenbox/i, 0x0042],
  [/fillablemetalbox|metalbox/i, 0x0044],
  [/fillablemetalgoldenchest|goldenchest/i, 0x0048],
  [/fillablemetalchest|metalchest/i, 0x0048],
  [/fillablewoodenchest|woodenchest|chest|coffer|footlocker/i, 0x0049],
  [/drawer|armoire|cabinet|desk/i, 0x004B],
  [/bookcase/i, 0x004C],
];

function gumpForContainer(type, itemId) {
  const t = String(type ?? '');
  for (const [re, gump] of CONTAINER_GUMPS) if (re.test(t)) return gump;
  switch (itemId | 0) {
    case 0x0E77: return 0x003E;
    case 0x09AA:
    case 0x0E7D: return 0x0042;
    case 0x09A8:
    case 0x0E80:
    case 0x09A9:
    case 0x0E7E:
    case 0x0E3C:
    case 0x0E3D:
    case 0x0E3E:
    case 0x0E3F: return 0x0044;
    case 0x09AB:
    case 0x0E40:
    case 0x0E41: return 0x0048;
    case 0x0E42:
    case 0x0E43: return 0x0049;
    default: return 0x003C;
  }
}

let _cache = null;
function loadCatalog() {
  if (_cache) return _cache;
  if (!existsSync(DECO_PATH)) return [];
  try {
    _cache = JSON.parse(readFileSync(DECO_PATH, 'utf8'));
  } catch (e) {
    console.warn('[decorate] cannot read decorations.json:', e.message);
    _cache = [];
  }
  return _cache;
}

/**
 * Apply the catalog to the world. Returns counts. Idempotent — keeps a
 * registry on the world so re-runs don't double up.
 *
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 * @param {{facets?: number[]}} [opts]
 */
export function applyDecorations(api, opts = {}) {
  const catalog = loadCatalog();
  if (!catalog.length) {
    api.log('[decorate] catalog empty — run `node packages/extractor/decoration.js` first');
    return { added: 0, skipped: 0 };
  }
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  if (!world._decorationApplied) world._decorationApplied = new Set();
  let added = 0; let skipped = 0;
  for (const e of catalog) {
    if (wantFacets && !wantFacets.has(e.map)) { skipped++; continue; }
    if (world._decorationApplied.has(e.map)) { skipped++; continue; }
    const script = classifyType(e.type, e.itemId);
    // Skip entries that another bulk loader owns (doors, signs,
    // teleporters, moongates). Without this skip we used to create the
    // same item twice — once as a plain static here and once with the
    // proper interactive payload from doorgen / signgen / telgen, with
    // half the tiles ending up non-interactive depending on which sprite
    // the click hit first.
    if (script === DELEGATED) { skipped++; continue; }
    const data = {
      itemId: e.itemId,
      hue: e.hue ?? 0,
      x: e.x, y: e.y, z: e.z, map: e.map,
      name: e.name,
      movable: false,
    };
    if (e.light) data.light = e.light;
    if (script === 'fillable-container') {
      Object.assign(data, {
        script,
        kind: 'container',
        container: true,
        gumpId: gumpForContainer(e.type, e.itemId),
        capacity: /barrel/i.test(e.type) ? 60 : 125,
        maxWeight: 400,
        servuoClass: e.type,
        servuoClasses: [e.type, 'FillableContainer', 'FillableContent', 'FillableBvrge'],
        fillableType: e.type,
        fillableContentType: e.contentType ?? null,
        contentType: e.contentType ?? null,
      });
    } else if (script === 'container') {
      Object.assign(data, {
        kind: 'container',
        container: true,
        gumpId: gumpForContainer(e.type, e.itemId),
        capacity: /barrel/i.test(e.type) ? 60 : 125,
        maxWeight: 400,
      });
    } else if (script) {
      data.script = script;
    }
    const item = createItem(api, world, data);
    item.isDecoration = true;
    item.decoType = e.type;
    if (e.facing) item.decoFacing = e.facing;
    if (e.labelNumber) item.labelNumber = e.labelNumber;
    if (script) item.script = script;
    // Stamp `solid: true` for impassable graphics — walls, columns,
    // pillars, statues, fences, gates, etc. without this, walls
    // placed by [decorate were transparent for collision (movement.js
    // runtimeSolidAt yields `it.door || it.solid`, neither was set).
    // Use the housedata role table when available — its `wall` /
    // `roof` classifications are the same source the renderer uses,
    // so visual + collision stay in sync. Roofs are NOT solid (you
    // walk under them); only walls + impassable furniture block.
    const role = api.housedata?.roleFor?.(e.itemId);
    if (role === 'wall' || role === 'pillar' || role === 'fence') {
      item.solid = true;
      // Walls + pillars are typically 20 z-units tall (CUO Wall.h
      // default). runtimeSolidAt's overlap check uses item.height; a
      // missing height defaults to 5 (low furniture) which would let
      // a tall mob "step over" a wall. Stamp explicit 20 so the
      // AABB rejects person-height (16) + ledge (5) = 21 transit.
      item.height = 20;
    } else if (role === 'static' && e.type && /(\bwall\b|column|pillar|statue|brazier)/i.test(e.type)) {
      // Decoration extractor occasionally tags walls as plain "static".
      // Heuristic fallback by ServUO C# class name.
      item.solid = true;
      item.height = 20;
    }
    added++;
  }
  // Mark facets as applied AFTER iteration so a partial pass over one
  // facet doesn't lock the whole catalog.
  if (wantFacets) for (const f of wantFacets) world._decorationApplied.add(f);
  else for (const e of catalog) world._decorationApplied.add(e.map);
  return { added, skipped };
}

/** Wipe every decoration on the given facets (default = all). Counterpart
 *  of `applyDecorations`. */
export function deleteDecorations(api, opts = {}) {
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  let removed = 0;
  // Snapshot serials first — destroying items mid-iteration mutates the
  // map and skips entries.
  const victims = [];
  for (const it of allItems({ world })) {
    if (!it.isDecoration) continue;
    if (wantFacets && !wantFacets.has(it.map)) continue;
    victims.push(it.serial);
  }
  for (const s of victims) { destroyItemBySerial(api, s); removed++; }
  if (wantFacets) for (const f of wantFacets) world._decorationApplied?.delete(f);
  else world._decorationApplied?.clear();
  return { removed };
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};

  api.commands.register({
    name: 'decorate',
    help: '[decorate [facet] — populate the world with extracted ServUO Static/furniture decorations.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      const facets = args.length ? args.map((s) => parseInt(s, 10)).filter(Number.isFinite) : null;
      const r = applyDecorations(api, { facets });
      ctx.state.sendSystemMessage(`Decorate: added ${r.added}, skipped ${r.skipped}.`);
    },
  });

  api.commands.register({
    name: 'decoratedelete',
    help: '[decoratedelete [facet] — remove every decoration generated by [decorate.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      const facets = args.length ? args.map((s) => parseInt(s, 10)).filter(Number.isFinite) : null;
      const r = deleteDecorations(api, { facets });
      ctx.state.sendSystemMessage(`DecorateDelete: removed ${r.removed} items.`);
    },
  });

  return () => { /* commands auto-unregistered by host */ };
}
