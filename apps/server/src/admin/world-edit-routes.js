// Data-catalog, map-tile, and world-static authoring routes.

import fs from 'node:fs';
import path from 'node:path';
import { tileDataTable } from '../world/movement.js';
import { invalidateLosCache } from '../world/los.js';
import { extMapTileEdit, NodeUOCapability } from '@uo/protocol';
import { parseSerial } from './route-helpers.js';

export function registerWorldEditRoutes(routes, {
  scriptsDir, saveDir, scriptRuntime, world, mapProvider, sharedCtx, queryInt, registerUndoableMutation,
}) {
  const DATA_ROOT = path.resolve(scriptsDir, 'data');
  function _confineToData(rel) {
    const full = path.resolve(DATA_ROOT, rel);
    if (!full.startsWith(DATA_ROOT + path.sep) && full !== DATA_ROOT) {
      throw new Error('path escapes data/ subtree');
    }
    return full;
  }
  function _walkData(dir, prefix = '') {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel  = prefix ? `${prefix}/${name}` : name;
      const st   = fs.statSync(full);
      if (st.isDirectory()) {
        out.push(..._walkData(full, rel));
      } else if (st.isFile() && (name.endsWith('.json') || name.endsWith('.js'))) {
        out.push({ rel, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
    return out;
  }

  routes.push({
    method: 'GET', path: '/api/data/files',
    run: async () => ({ root: 'apps/scripts/src/data', files: _walkData(DATA_ROOT) }),
  });

  routes.push({
    method: 'GET', path: '/api/data/file',
    run: async ({ query }) => {
      // `query` is a URLSearchParams — use .get(), not direct prop access.
      const rel = String(query.get('rel') ?? '').trim();
      if (!rel) return { error: 'rel param required' };
      try {
        const full = _confineToData(rel);
        if (!fs.existsSync(full)) return { error: 'not found' };
        return { rel, content: fs.readFileSync(full, 'utf8') };
      } catch (e) { return { error: e.message }; }
    },
  });

  routes.push({
    method: 'POST', path: '/api/data/file',
    run: async ({ body }) => {
      const rel = String(body?.rel || '').trim();
      const content = body?.content;
      if (!rel) return { error: 'body.rel required' };
      if (typeof content !== 'string') return { error: 'body.content (string) required' };
      try {
        const full = _confineToData(rel);
        // JSON files: validate before writing — refusing a save with a
        // bad payload protects the live world from a typo that would
        // break the loader on next reload.
        if (rel.endsWith('.json')) {
          try { JSON.parse(content); }
          catch (e) { return { error: `invalid JSON: ${e.message}` }; }
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        // Auto-reload all scripts when body.reload is true. The
        // hot-watch in scriptRuntime ONLY fires on .js files (file
        // watcher), so JSON edits need an explicit kick.
        let reloaded = null;
        if (body?.reload && scriptRuntime?.load) {
          const t0 = Date.now();
          await scriptRuntime.load({ reason: `admin-data:${rel}`, emitEvent: true });
          reloaded = { ms: Date.now() - t0, loaded: scriptRuntime.loaded?.length ?? 0 };
        }
        return { ok: true, bytes: content.length, reloaded };
      } catch (e) { return { error: e.message }; }
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/data/file',
    run: async ({ query }) => {
      const rel = String(query.get('rel') ?? '').trim();
      if (!rel) return { error: 'rel param required' };
      try {
        const full = _confineToData(rel);
        if (!fs.existsSync(full)) return { error: 'not found' };
        fs.unlinkSync(full);
        return { ok: true };
      } catch (e) { return { error: e.message }; }
    },
  });

  // ---- World locations list (used by admin Iso editor "Go to…" picker) --
  // Mirrors the `[go` LOCATIONS catalogue so the iso editor can centre
  // the canvas on any canonical landmark / town / dungeon / shrine.
  // Cached at module load — the catalogue is static.
  let _locationsCache = null;
  routes.push({
    method: 'GET', path: '/api/locations',
    run: async () => {
      if (_locationsCache) return _locationsCache;
      try {
        const mod = await import('../../../scripts/src/commands/go.js');
        const reg = mod.LOCATIONS_REGISTRY ?? mod._LOCATIONS_FOR_TEST ?? {};
        const out = [];
        for (const [key, loc] of Object.entries(reg)) {
          if (!loc || !Number.isFinite(loc.x)) continue;
          out.push({
            key,
            label: loc.label ?? key,
            x: loc.x | 0, y: loc.y | 0, z: loc.z | 0,
            map: loc.map | 0,
          });
        }
        out.sort((a, b) => a.label.localeCompare(b.label));
        _locationsCache = { locations: out };
        return _locationsCache;
      } catch (e) {
        return { error: `failed to load locations: ${e.message}`, locations: [] };
      }
    },
  });

  // ---- Map editor (admin canvas paint tool) -----------------------------
  // Read a rectangular slice of the land map. Capped to 64×64 tiles per
  // request to keep payloads small (~24 KB). Returns the merged view —
  // overlay edits already applied.
  routes.push({
    method: 'GET', path: '/api/map/slice',
    run: ({ query }) => {
      const facet = queryInt(query, 'facet', 1, 0, 5);
      const x0 = queryInt(query, 'x', 1495, 0, 0xffff);
      const y0 = queryInt(query, 'y', 1625, 0, 0xffff);
      const w = queryInt(query, 'w', 32, 1, 64);
      const h = queryInt(query, 'h', 32, 1, 64);
      const tiles = new Array(w * h);
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const t = mapProvider.landAt(facet, x0 + dx, y0 + dy);
          tiles[dy * w + dx] = t ? [t.tileId, t.z] : [0, 0];
        }
      }
      return { facet, x: x0, y: y0, w, h, tiles, edits: mapProvider.editCount() };
    },
  });

  // Apply a batch of tile edits. Body: { facet, edits: [{x,y,tileId,z}] }.
  routes.push({
    method: 'POST', path: '/api/map/edit',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const edits = Array.isArray(body?.edits) ? body.edits : [];
      if (!edits.length) return { error: 'no edits' };
      if (edits.length > 4096) return { error: 'too many edits in one batch (max 4096)' };
      let applied = 0;
      // Compute a bounding box of edited tiles so the live-broadcast
      // pass below only re-syncs players actually within range of any
      // change (cheap proxy: refreshSurroundings re-streams the
      // player's full visible chunks).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const validEdits = [];
      for (const e of edits) {
        if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y) || !Number.isFinite(e?.tileId)) continue;
        if (e.x < 0 || e.y < 0 || e.x > 0xffff || e.y > 0xffff) continue;
        const normalized = { x: e.x | 0, y: e.y | 0, tileId: e.tileId & 0x3fff, z: Math.max(-128, Math.min(127, e.z | 0)) };
        mapProvider.setLandTile(facet, normalized.x, normalized.y, normalized.tileId, normalized.z);
        validEdits.push(normalized);
        if (e.x < minX) minX = e.x; if (e.x > maxX) maxX = e.x;
        if (e.y < minY) minY = e.y; if (e.y > maxY) maxY = e.y;
        applied++;
      }
      // Persist immediately so a server crash doesn't lose the edit
      // session's work. Cheap (sparse JSON) — typically <1ms.
      if (!validEdits.length) return { error: 'no valid edits' };
      const r = mapProvider.saveEditsSync(path.join(saveDir, 'map-edits.json'));
      // LOS cache invalidation — any tile that just changed Z may have
      // become walkable / unwalkable, so cached LOS answers from the
      // last 100 ms are no longer trustworthy. Cheap clear (drops 4096
      // entries max).
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Live tile-push — every connected player on the same facet
      // within ~32 tiles of the edit bounding box gets a 0xBF 0x6E
      // MapTileEdit packet so their local landAt overlay updates and
      // chunk visuals re-mount. No relog / [resync needed any more.
      let broadcast = 0;
      if (applied > 0) {
        const pkt = extMapTileEdit(facet, validEdits);
        const cx = (minX + maxX) >> 1;
        const cy = (minY + maxY) >> 1;
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client) continue;
          if (!m.client.supportsNodeUO?.(NodeUOCapability.WorldEditing)) continue;
          if (m.map !== facet) continue;
          if (Math.abs(m.x - cx) > 32 || Math.abs(m.y - cy) > 32) continue;
          try { m.client.send(pkt); broadcast++; }
          catch { /* socket transient */ }
        }
      }
      return { ok: true, applied, totalEdits: mapProvider.editCount(), broadcast, persist: r };
    },
  });

  // Wipe all overlay edits + delete the persisted file.
  routes.push({
    method: 'POST', path: '/api/map/reset',
    run: () => {
      const all = [...mapProvider.iterEdits()];
      for (const e of all) mapProvider.clearLandTile(e.facet, e.x, e.y);
      try { fs.unlinkSync(path.join(saveDir, 'map-edits.json')); } catch { /* missing */ }
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Restore the original land tiles in connected web clients too. Split
      // large overlays into protocol-safe chunks and only send a chunk to
      // players close enough to see its bounding box.
      let broadcast = 0;
      const byFacet = new Map();
      for (const e of all) {
        const list = byFacet.get(e.facet) ?? [];
        const original = mapProvider.landAt(e.facet, e.x, e.y);
        list.push({ x: e.x, y: e.y, tileId: original?.tileId ?? 0, z: original?.z ?? 0 });
        byFacet.set(e.facet, list);
      }
      for (const [facet, edits] of byFacet) {
        for (let start = 0; start < edits.length; start += 4096) {
          const chunk = edits.slice(start, start + 4096);
          const minX = Math.min(...chunk.map((e) => e.x));
          const maxX = Math.max(...chunk.map((e) => e.x));
          const minY = Math.min(...chunk.map((e) => e.y));
          const maxY = Math.max(...chunk.map((e) => e.y));
          const pkt = extMapTileEdit(facet, chunk);
          for (const mob of (world?.mobiles?.values?.() ?? [])) {
            if (!mob.client || mob.map !== facet) continue;
            if (!mob.client.supportsNodeUO?.(NodeUOCapability.WorldEditing)) continue;
            if (mob.x < minX - 32 || mob.x > maxX + 32 || mob.y < minY - 32 || mob.y > maxY + 32) continue;
            try { mob.client.send(pkt); broadcast++; } catch { /* socket race */ }
          }
        }
      }
      return { ok: true, cleared: all.length, broadcast };
    },
  });
  routes.push({
    method: 'POST', path: '/api/scripts/dry-run',
    run: async ({ body }) => scriptRuntime?.dryRunOne
      ? scriptRuntime.dryRunOne(String(body?.path ?? ''))
      : { ok: false, error: 'dry-run unavailable on runtime' },
  });

  // Tiledata search — pagination + substring match on the static or
  // land tile name. Used by the editor palette browser to let admins
  // discover any 0xNNNN graphic without memorising ids. Cap at 200
  // matches per call so a one-letter query doesn't ship a 4 MB
  // payload. `kind` filters: 'static' (default), 'land', or 'all'.
  routes.push({
    method: 'GET', path: '/api/tiles/search',
    run: ({ query }) => {
      const q = String(query.get('q') ?? '').trim().toLowerCase();
      const kind = query.get('kind') ?? 'static';
      const limit = queryInt(query, 'limit', 80, 1, 200);
      const offset = queryInt(query, 'offset', 0, 0, 100_000);
      const category = String(query.get('category') ?? 'all').trim().toLowerCase();
      const td = tileDataTable();
      const matches = [];
      let total = 0;
      // tiledata.statics is indexed by GLOBAL art id (LAND_COUNT + local).
      // Callers (palette, /api/statics/place, runtime item.itemId) all use
      // LOCAL static ids. Subtract LAND_COUNT when emitting so the wire
      // contract stays LOCAL-only and the editor's atlas lookup adds the
      // offset itself when fetching sprites.
      const LAND_COUNT = (td.land?.length ?? 16384) | 0;
      const categoryOf = (name, type) => {
        if (type === 'land') return 'terrain';
        const n = String(name ?? '').toLowerCase();
        if (/door|gate|portcullis/.test(n)) return 'doors';
        if (/chair|table|bench|bed|throne|stool|desk|bookcase|bookshelf|armoire|dresser/.test(n)) return 'furniture';
        if (/candle|lamp|lantern|torch|brazier|candelabra|fireplace|hearth/.test(n)) return 'lighting';
        if (/tree|plant|flower|grass|rock|boulder|bush|shrub|vine|mushroom|log|stump/.test(n)) return 'nature';
        if (/wall|floor|roof|column|pillar|stair|window|arch|railing|fence|brick|stone|plaster/.test(n)) return 'architecture';
        if (/chest|crate|barrel|box|bag|basket|container|cabinet/.test(n)) return 'containers';
        if (/sign|banner|flag|tapestry|painting|portrait/.test(n)) return 'signs';
        return 'misc';
      };
      const trySource = (arr, type) => {
        const idShift = type === 'static' ? LAND_COUNT : 0;
        for (let i = 0; i < arr.length; i++) {
          const e = arr[i];
          if (!e) continue;
          const name = String(e.name ?? '').toLowerCase();
          if (!name) continue;
          if (/^no\s*draw(?:\b|_)/i.test(name)) continue;
          const outId = i - idShift;
          if (outId < 0) continue;
          const tileCategory = categoryOf(e.name, type);
          if (category !== 'all' && type === 'static' && tileCategory !== category) continue;
          let queryMatches = q === '';
          if (/^0x[0-9a-f]+$/i.test(q)) {
            // Accept either local (matches outId) or global (matches i)
            // hex queries so power users can paste either.
            const want = parseInt(q, 16);
            queryMatches = outId === want || i === want;
          } else if (/^\d+$/.test(q)) {
            const want = parseInt(q, 10);
            queryMatches = outId === want || i === want;
          } else if (q) {
            queryMatches = name.includes(q);
          }
          if (!queryMatches) continue;
          if (total >= offset && matches.length < limit) {
            matches.push({ type, id: outId, name: e.name, height: e.height | 0,
              layer: e.layer | 0, category: tileCategory });
          }
          total++;
        }
      };
      if (kind === 'land' || kind === 'all') trySource(td.land ?? [], 'land');
      if (kind === 'static' || kind === 'all') trySource(td.statics ?? [], 'static');
      return { q, kind, category, offset, limit, count: matches.length,
        total, hasMore: offset + matches.length < total, matches };
    },
  });

  // Read-only overlay dump for the client. Returns every overlay edit
  // for one facet (or all facets if 'facet' query is omitted). The
  // browser client fetches this at boot + on facet change so its
  // local landAt() can apply the same overrides the server uses for
  // walkability — without this, paint strokes from the admin Map
  // Editor showed only on the canvas, not in-game.
  routes.push({
    method: 'GET', path: '/api/map/overlay',
    run: ({ query }) => {
      const wantFacet = query.has('facet') ? Number(query.get('facet')) : null;
      const out = [];
      for (const e of mapProvider.iterEdits()) {
        if (wantFacet != null && e.facet !== wantFacet) continue;
        out.push(e);
      }
      return { facet: wantFacet, edits: out };
    },
  });

  // ---- Static editor (canvas-based item placement) ---------------------
  // Returns every static at every tile in a rectangle. Different from
  // /api/map/slice (which only returns land tile id/z) — this includes
  // ground items + statics from the on-disk map AND from runtime
  // world.items (admin-placed builds, doorgen, etc.).
  routes.push({
    method: 'GET', path: '/api/statics/slice',
    run: ({ query }) => {
      const facet = queryInt(query, 'facet', 1, 0, 5);
      const x0 = queryInt(query, 'x', 1495, 0, 0xffff);
      const y0 = queryInt(query, 'y', 1625, 0, 0xffff);
      const w = queryInt(query, 'w', 32, 1, 64);
      const h = queryInt(query, 'h', 32, 1, 64);
      // Map of `${dx}|${dy}` → array of {tileId, z, hue, source} where
      // source is 'static' (from chunk static layer, fixed) or 'item'
      // (from world.items, mutable via [del / build).
      const cells = {};
      const stackFor = (wx, wy) => {
        const key = `${wx - x0}|${wy - y0}`;
        return (cells[key] ??= []);
      };
      // Decode baked map statics once per 8x8 block. The previous nested
      // tile loop called staticsAt() 4096 times for a 64x64 view and each
      // call rescanned its block's complete variable-length record list.
      if (typeof mapProvider.staticsInRect === 'function') {
        for (const s of mapProvider.staticsInRect(facet, x0, y0, w, h)) {
          stackFor(s.x, s.y).push({ tileId: s.tileId, z: s.z, hue: s.hue, source: 'static' });
        }
      } else {
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
          for (const s of mapProvider.staticsAt(facet, x0 + dx, y0 + dy)) {
            stackFor(x0 + dx, y0 + dy).push({ tileId: s.tileId, z: s.z, hue: s.hue, source: 'static' });
          }
        }
      }

      // Runtime items: query all overlapping sector buckets once, then
      // filter into cells. Keep the single-tile fallback for lightweight
      // test fixtures that expose only itemSerialsAt().
      const sectorsReady = world?.sectors
        && (world.items.size === 0 || world.sectors.itemsIndexed?.() > 0);
      const pushRuntime = (it) => {
        if (!it || it.parent != null || (it.map ?? 1) !== facet) return;
        if (it.x < x0 || it.x >= x0 + w || it.y < y0 || it.y >= y0 + h) return;
        stackFor(it.x, it.y).push({
          tileId: it.itemId, z: it.z, hue: it.hue ?? 0,
          source: (it.house != null || it.boat != null || it.multiId != null || it.addon != null || it.addonName != null) ? 'multi' : 'item',
          serial: '0x' + (it.serial >>> 0).toString(16),
        });
      };
      if (sectorsReady && world.sectors.itemSerialsNear) {
        const cx = x0 + ((w - 1) >> 1), cy = y0 + ((h - 1) >> 1);
        const range = Math.ceil(Math.max(w, h) / 2) + 8;
        for (const serial of world.sectors.itemSerialsNear(facet, cx, cy, range)) {
          pushRuntime(world.items.get(serial));
        }
      } else if (sectorsReady && world.sectors.itemSerialsAt) {
        const seen = new Set();
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
          for (const serial of world.sectors.itemSerialsAt(facet, x0 + dx, y0 + dy)) {
            if (seen.has(serial)) continue;
            seen.add(serial); pushRuntime(world.items.get(serial));
          }
        }
      } else {
        for (const it of (world?.items?.values?.() ?? [])) pushRuntime(it);
      }
      return { facet, x: x0, y: y0, w, h, cells };
    },
  });

  // Place a single static at the given tile. Spawned as a runtime item
  // (movable:false, isDecoration:true) so it round-trips through saves
  // and `[del` removes it. Returns the new item's serial.
  routes.push({
    method: 'POST', path: '/api/statics/place',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const x = Number(body?.x ?? 0) | 0;
      const y = Number(body?.y ?? 0) | 0;
      const z = Number(body?.z ?? 0) | 0;
      const itemId = Number(body?.itemId ?? 0) | 0;
      const hue = Number(body?.hue ?? 0) & 0xffff;
      const td = tileDataTable();
      const staticCount = Math.max(0, (td.statics?.length ?? 0) - (td.land?.length ?? 0));
      if (!itemId || itemId < 1 || itemId >= staticCount) {
        return { error: `bad itemId 0x${itemId.toString(16)} (valid local static range: 0x1..0x${Math.max(0, staticCount - 1).toString(16)})` };
      }
      const items = sharedCtx?.items ?? null;
      const createItem = items?.createItem;
      if (!createItem) return { error: 'items.createItem unavailable' };
      const it = createItem(world, { itemId, hue, x, y, z, map: facet, movable: false });
      it.isDecoration = true;
      it.script = 'static';
      // Newly-placed static may block (or pass) LOS — drop the cache
      // so spells / archery checks pick up the change immediately.
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Broadcast worldItemSA to nearby players.
      const wi = sharedCtx?.protocol?.worldItemSA?.({
        serial: it.serial, itemId: it.itemId, hue: it.hue, amount: 1,
        x: it.x, y: it.y, z: it.z, flags: 0x00,
      });
      if (wi) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - x) > 18 || Math.abs(m.y - y) > 18) continue;
          m.client.send(wi);
        }
      }
      return { ok: true, serial: '0x' + (it.serial >>> 0).toString(16) };
    },
  });

  // Export a rectangular slice as a "multi" prefab — save the runtime
  // items at every tile in the rect to a named JSON file. Reuse via
  // /api/statics/import-prefab to drop a copy at a new location.
  routes.push({
    method: 'POST', path: '/api/statics/save-prefab',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const x0 = Number(body?.x0) | 0, y0 = Number(body?.y0) | 0;
      const x1 = Number(body?.x1) | 0, y1 = Number(body?.y1) | 0;
      const name = String(body?.name ?? '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
      if (!name) return { error: 'name required (alphanumeric)' };
      // Snap to ascending bounds — operator can pass corners in any order.
      const lx = Math.min(x0, x1), hx = Math.max(x0, x1);
      const ly = Math.min(y0, y1), hy = Math.max(y0, y1);
      const includeFixed = !!body?.includeFixed;
      const tiles = [];
      // Runtime items in range — relative offsets so prefab is portable.
      for (const it of (world?.items?.values?.() ?? [])) {
        if (it.parent != null) continue;
        if ((it.map ?? 1) !== facet) continue;
        if (it.x < lx || it.x > hx || it.y < ly || it.y > hy) continue;
        tiles.push({
          dx: it.x - lx, dy: it.y - ly, z: it.z | 0,
          itemId: it.itemId | 0, hue: it.hue | 0, source: 'item',
        });
      }
      if (includeFixed) {
        for (let y = ly; y <= hy; y++) {
          for (let x = lx; x <= hx; x++) {
            for (const s of mapProvider.staticsAt(facet, x, y)) {
              tiles.push({
                dx: x - lx, dy: y - ly, z: s.z | 0,
                itemId: s.tileId | 0, hue: s.hue | 0, source: 'static',
              });
            }
          }
        }
      }
      const prefab = {
        name, sizeX: hx - lx + 1, sizeY: hy - ly + 1,
        savedAt: new Date().toISOString(),
        sourceFacet: facet, sourceX: lx, sourceY: ly,
        tiles,
      };
      const dir = path.join(saveDir, 'prefabs');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
      const file = path.join(dir, `${name}.json`);
      try { fs.writeFileSync(file, JSON.stringify(prefab, null, 2)); }
      catch (e) { return { error: e.message }; }
      return { ok: true, name, file: `prefabs/${name}.json`, tileCount: tiles.length, sizeX: prefab.sizeX, sizeY: prefab.sizeY };
    },
  });

  // List saved prefabs.
  routes.push({
    method: 'GET', path: '/api/statics/prefabs',
    run: () => {
      const dir = path.join(saveDir, 'prefabs');
      if (!fs.existsSync(dir)) return { prefabs: [] };
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          out.push({
            name: meta.name, file: `prefabs/${f}`, sizeX: meta.sizeX, sizeY: meta.sizeY,
            tileCount: meta.tiles?.length ?? 0, savedAt: meta.savedAt,
          });
        } catch { /* skip corrupt */ }
      }
      return { prefabs: out };
    },
  });

  // Stamp a saved prefab at (x, y) on the given facet. Items are
  // recreated as runtime items (not the original serials).
  routes.push({
    method: 'POST', path: '/api/statics/import-prefab',
    run: ({ body }) => {
      const name = String(body?.name ?? '').replace(/[^a-z0-9_-]/gi, '_');
      const facet = Number(body?.facet ?? 1);
      const baseX = Number(body?.x) | 0;
      const baseY = Number(body?.y) | 0;
      const file = path.join(saveDir, 'prefabs', `${name}.json`);
      if (!fs.existsSync(file)) return { error: `prefab '${name}' not found` };
      let prefab;
      try { prefab = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { return { error: e.message }; }
      const items = sharedCtx?.items?.createItem;
      if (!items) return { error: 'items.createItem unavailable' };
      let placed = 0;
      const newItems = [];
      for (const t of prefab.tiles ?? []) {
        if (t.source === 'static') continue;  // can't recreate fixed map statics
        try {
          const it = items(world, {
            itemId: t.itemId, hue: t.hue,
            x: baseX + t.dx, y: baseY + t.dy, z: t.z,
            map: facet, movable: false,
          });
          it.isDecoration = true; it.script = 'static';
          newItems.push(it);
          placed++;
        } catch { /* per-tile failures don't block batch */ }
      }
      // Broadcast every new item to nearby players in one pass.
      const wiBuilder = sharedCtx?.protocol?.worldItemSA;
      if (wiBuilder) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - baseX) > 32 || Math.abs(m.y - baseY) > 32) continue;
          for (const it of newItems) {
            if (Math.abs(m.x - it.x) > 18 || Math.abs(m.y - it.y) > 18) continue;
            m.client.send(wiBuilder({
              serial: it.serial, itemId: it.itemId, hue: it.hue, amount: 1,
              x: it.x, y: it.y, z: it.z, flags: 0x00,
            }));
          }
        }
      }
      return { ok: true, name, placed, total: prefab.tiles?.length ?? 0 };
    },
  });

  // Remove a single placed static by serial.
  routes.push({
    method: 'POST', path: '/api/statics/remove',
    run: ({ body }) => {
      const serial = parseSerial(body?.serial);
      if (!serial) return { error: 'serial required' };
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'item not found' };
      const x = it.x, y = it.y, facet = it.map;
      const items = sharedCtx?.items ?? null;
      try { items?.destroyItem?.(world, serial); }
      catch (e) { return { error: e.message }; }
      const rm = sharedCtx?.protocol?.removeEntity?.(serial);
      if (rm) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - x) > 18 || Math.abs(m.y - y) > 18) continue;
          m.client.send(rm);
        }
      }
      return { ok: true };
    },
  });

  // Atomic editor commit. The old UI fired one HTTP request per tile, which
  // was slow and could leave half a brush stroke applied after a disconnect.
  // Validate the complete command first, stage all additions, and only then
  // perform deterministic removals. A failed create rolls every staged item
  // back before returning an error.
  routes.push({
    method: 'POST', path: '/api/statics/batch',
    run: ({ body, session }) => {
      const facet = Number(body?.facet ?? 1) | 0;
      const additions = Array.isArray(body?.additions) ? body.additions : [];
      const removals = [...new Set(Array.isArray(body?.removals) ? body.removals.map(parseSerial).filter(Boolean) : [])];
      if (!additions.length && !removals.length) return { error: 'empty batch' };
      if (additions.length + removals.length > 4096) return { error: 'batch exceeds 4096 mutations' };
      if (facet < 0 || facet > 5) return { error: 'invalid facet' };
      const td = tileDataTable();
      const staticCount = Math.max(0, (td.statics?.length ?? 0) - (td.land?.length ?? 0));
      const normalized = [];
      for (const row of additions) {
        const itemId = Number(row?.itemId) | 0;
        const x = Number(row?.x), y = Number(row?.y), z = Number(row?.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
            || x < 0 || x > 0xffff || y < 0 || y > 0xffff
            || itemId < 1 || itemId >= staticCount) return { error: 'invalid addition in batch' };
        normalized.push({ itemId, x: x | 0, y: y | 0,
          z: Math.max(-128, Math.min(127, z | 0)), hue: Number(row?.hue ?? 0) & 0xffff });
      }
      const removalSnapshots = [];
      for (const serial of removals) {
        const item = world.items.get(serial);
        if (!item || item.parent != null) return { error: `removal item 0x${serial.toString(16)} not found on ground` };
        removalSnapshots.push({ serial: item.serial, itemId: item.itemId, hue: item.hue ?? 0,
          amount: item.amount ?? 1, map: item.map, x: item.x, y: item.y, z: item.z,
          name: item.name, movable: item.movable, parent: null, gumpId: item.gumpId ?? 0,
          gridX: item.gridX ?? 0, gridY: item.gridY ?? 0, gridLocation: item.gridLocation ?? 0,
          layer: item.layer ?? 0, template: item.template, isDecoration: !!item.isDecoration,
          script: item.script });
      }
      const create = sharedCtx?.items?.createItem;
      const destroy = sharedCtx?.items?.destroyItem;
      if (!create || !destroy) return { error: 'item mutation API unavailable' };
      const created = [];
      try {
        for (const row of normalized) {
          const item = create(world, { ...row, map: facet, movable: false });
          item.isDecoration = true; item.script = 'static';
          world.syncSpatialItem?.(item);
          created.push(item);
        }
      } catch (error) {
        for (const item of created) { try { destroy(world, item.serial); } catch {} }
        return { error: `batch rolled back: ${error?.message ?? error}`, rolledBack: created.length };
      }
      for (const serial of removals) destroy(world, serial);
      try { invalidateLosCache(); } catch { /* advisory */ }
      // One surrounding refresh per affected client, instead of N packets per
      // tile. Standard clients receive the normal UO item/remove packets.
      const touched = [...created, ...removalSnapshots];
      const removePackets = new Map(removalSnapshots.map((item) => [item.serial,
        sharedCtx?.protocol?.removeEntity?.(item.serial) ?? null]));
      for (const mobile of world.onlineMobiles?.() ?? []) {
        if ((mobile.map | 0) !== facet || !mobile.client) continue;
        for (const item of created) {
          if (Math.max(Math.abs(mobile.x - item.x), Math.abs(mobile.y - item.y)) > 18) continue;
          try { mobile.client.sendItem?.(item); } catch { /* socket race */ }
        }
        for (const item of removalSnapshots) {
          if (Math.max(Math.abs(mobile.x - item.x), Math.abs(mobile.y - item.y)) > 18) continue;
          const packet = removePackets.get(item.serial);
          if (packet) { try { mobile.client.send(packet); } catch { /* socket race */ } }
        }
        try { sharedCtx?.refreshSurroundings?.(mobile.client); } catch { /* advisory */ }
      }
      const auditUndoId = registerUndoableMutation(session?.account, 'statics.batch', {
        facet, createdSerials: created.map((item) => item.serial >>> 0),
        removedSnapshots: removalSnapshots.map(({ serial: _serial, ...snapshot }) => snapshot),
      });
      return { ok: true, added: created.length, removed: removals.length, auditUndoId,
        serials: created.map((item) => `0x${(item.serial >>> 0).toString(16)}`), touched: touched.length };
    },
  });
}
