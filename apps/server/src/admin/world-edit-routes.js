// Data-catalog, map-tile, and world-static authoring routes.

import fs from 'node:fs';
import path from 'node:path';
import { tileDataTable } from '../world/movement.js';
import { invalidateLosCache } from '../world/los.js';
import { NodeUOFeature, NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { sendNodeUOFeature } from '../net/handlers/nodeuo-modern.js';
import { parseSerial } from './route-helpers.js';

export function registerWorldEditRoutes(routes, {
  scriptsDir, saveDir, scriptRuntime, world, mapProvider, sharedCtx, queryInt, registerUndoableMutation,
}) {
  const DATA_ROOT = path.resolve(scriptsDir, 'data');
  const mapCellInBounds = (facet, x, y) => {
    const meta = mapProvider?.metaFor?.(facet);
    if (!meta) return true; // Lightweight/test providers may not expose metadata.
    const width = Number(meta.blocksWide) * 8;
    const height = Number(meta.blocksTall) * 8;
    return Number.isSafeInteger(width) && Number.isSafeInteger(height)
      && x >= 0 && y >= 0 && x < width && y < height;
  };
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
      if (!Number.isInteger(facet) || facet < 0 || facet > 5) return { error: 'invalid facet' };
      const landCount = Math.min(0x4000, tileDataTable().land?.length ?? 0x4000);
      const byCell = new Map();
      for (const edit of edits) {
        const x = Number(edit?.x), y = Number(edit?.y), z = Number(edit?.z), tileId = Number(edit?.tileId);
        if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !Number.isInteger(tileId)
            || x < 0 || y < 0 || x > 0xffff || y > 0xffff
            || z < -128 || z > 127 || tileId < 0 || tileId >= landCount
            || !mapCellInBounds(facet, x, y)) {
          return { error: 'invalid land edit; the complete batch was rejected' };
        }
        byCell.set(`${x}|${y}`, { x, y, tileId, z });
      }
      const validEdits = [...byCell.values()];
      // Compute a bounding box of edited tiles so the live-broadcast
      // pass below only re-syncs players actually within range of any
      // change (cheap proxy: refreshSurroundings re-streams the
      // player's full visible chunks).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const edit of validEdits) {
        if (edit.x < minX) minX = edit.x; if (edit.x > maxX) maxX = edit.x;
        if (edit.y < minY) minY = edit.y; if (edit.y > maxY) maxY = edit.y;
      }
      const wantedKeys = new Set(validEdits.map((edit) => `${edit.x}|${edit.y}`));
      const previous = new Map();
      for (const edit of mapProvider.iterEdits?.() ?? []) {
        if ((edit.facet | 0) !== facet) continue;
        const key = `${edit.x}|${edit.y}`;
        if (wantedKeys.has(key)) previous.set(key, edit);
      }
      const rollback = () => {
        for (const edit of validEdits) {
          const old = previous.get(`${edit.x}|${edit.y}`);
          if (old) mapProvider.setLandTile(facet, edit.x, edit.y, old.tileId, old.z);
          else mapProvider.clearLandTile(facet, edit.x, edit.y);
        }
      };
      try {
        for (const edit of validEdits) mapProvider.setLandTile(facet, edit.x, edit.y, edit.tileId, edit.z);
      } catch (error) {
        try { rollback(); } catch { /* best effort; provider is in-process */ }
        return { error: `land edit rolled back: ${error?.message ?? error}` };
      }
      // Persist before broadcasting. A failed write restores the exact sparse
      // overlay state, so the browser can safely retain and retry its batch.
      let r;
      try { r = mapProvider.saveEditsSync(path.join(saveDir, 'map-edits.json')); }
      catch (error) {
        rollback();
        return { error: `land edit rolled back: ${error?.message ?? error}`, rolledBack: validEdits.length };
      }
      if (r?.error) {
        rollback();
        return { error: `land edit rolled back: ${r.error}`, rolledBack: validEdits.length };
      }
      // LOS cache invalidation — any tile that just changed Z may have
      // become walkable / unwalkable, so cached LOS answers from the
      // last 100 ms are no longer trustworthy. Cheap clear (drops 4096
      // entries max).
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Live tile-push — negotiated NodeUO clients near the edit receive a
      // typed delta and remount the affected chunks. Classic clients keep
      // their standard UO view and see the change after reconnect/resync.
      let broadcast = 0;
      if (validEdits.length > 0) {
        const jsonEdits = validEdits.map((edit) => ({ facet, ...edit }));
        const cx = (minX + maxX) >> 1;
        const cy = (minY + maxY) >> 1;
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client) continue;
          if (!m.client.supportsNodeUO?.(NodeUOFeature.WorldEditing)) continue;
          if (m.map !== facet) continue;
          if (Math.abs(m.x - cx) > 32 || Math.abs(m.y - cy) > 32) continue;
          try {
            broadcast += !!sendNodeUOFeature(m.client, {
              feature: NodeUOFeature.WorldEditing, kind: NodeUOJsonKind.Delta,
              payload: { operation: 'map-edits', facet, edits: jsonEdits },
            });
          }
          catch { /* socket transient */ }
        }
      }
      return { ok: true, applied: validEdits.length, totalEdits: mapProvider.editCount(), broadcast, persist: r };
    },
  });

  // Wipe all overlay edits + delete the persisted file.
  routes.push({
    method: 'POST', path: '/api/map/reset',
    run: () => {
      const all = [...mapProvider.iterEdits()];
      const overlayFile = path.join(saveDir, 'map-edits.json');
      try { if (fs.existsSync(overlayFile)) fs.unlinkSync(overlayFile); }
      catch (error) { return { error: `could not persist overlay reset: ${error.message}` }; }
      for (const e of all) mapProvider.clearLandTile(e.facet, e.x, e.y);
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
          const jsonEdits = chunk.map((edit) => ({ facet, ...edit }));
          for (const mob of (world?.mobiles?.values?.() ?? [])) {
            if (!mob.client || mob.map !== facet) continue;
            if (!mob.client.supportsNodeUO?.(NodeUOFeature.WorldEditing)) continue;
            if (mob.x < minX - 32 || mob.x > maxX + 32 || mob.y < minY - 32 || mob.y > maxY + 32) continue;
            try {
              broadcast += !!sendNodeUOFeature(mob.client, {
                feature: NodeUOFeature.WorldEditing, kind: NodeUOJsonKind.Delta,
                payload: { operation: 'map-edits', facet, edits: jsonEdits },
              });
            } catch { /* socket race */ }
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
      // tiledata.statics is indexed by LOCAL UO static id. The art atlas uses
      // the unified/global key (0x4000 + local), and the browser adds that
      // offset only while resolving the sprite. Never shift tiledata here or
      // names/flags become associated with the wrong art.
      const STATIC_COUNT = Math.min(0xc000, td.statics?.length ?? 0);
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
        const count = type === 'static' ? STATIC_COUNT : arr.length;
        for (let i = 0; i < count; i++) {
          const e = arr[i];
          if (!e) continue;
          const name = String(e.name ?? '').toLowerCase();
          if (!name) continue;
          if (/^no\s*draw(?:\b|_)/i.test(name)) continue;
          const outId = i;
          const tileCategory = categoryOf(e.name, type);
          if (category !== 'all' && type === 'static' && tileCategory !== category) continue;
          let queryMatches = q === '';
          if (/^0x[0-9a-f]+$/i.test(q)) {
            // Accept local ids and the atlas/global spelling so power users
            // can paste values copied from either data source.
            const want = parseInt(q, 16);
            queryMatches = outId === want || (type === 'static' && outId + 0x4000 === want);
          } else if (/^\d+$/.test(q)) {
            const want = parseInt(q, 10);
            queryMatches = outId === want || (type === 'static' && outId + 0x4000 === want);
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
          editable: it.isDecoration === true || it.script === 'static',
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
      const rawFacet = Number(body?.facet ?? 1);
      const rawX = Number(body?.x), rawY = Number(body?.y), rawZ = Number(body?.z ?? 0);
      const rawItemId = Number(body?.itemId);
      if (!Number.isInteger(rawFacet) || rawFacet < 0 || rawFacet > 5
          || !Number.isInteger(rawX) || rawX < 0 || rawX > 0xffff
          || !Number.isInteger(rawY) || rawY < 0 || rawY > 0xffff
          || !Number.isInteger(rawZ) || rawZ < -128 || rawZ > 127
          || !Number.isInteger(rawItemId)
          || !mapCellInBounds(rawFacet, rawX, rawY)) return { error: 'invalid static placement coordinates' };
      const facet = rawFacet, x = rawX, y = rawY, z = rawZ, itemId = rawItemId;
      const hue = Number(body?.hue ?? 0) & 0xffff;
      const td = tileDataTable();
      const staticCount = Math.min(0xc000, td.statics?.length ?? 0);
      if (!itemId || itemId < 1 || itemId >= staticCount) {
        return { error: `bad itemId 0x${itemId.toString(16)} (valid local static range: 0x1..0x${Math.max(0, staticCount - 1).toString(16)})` };
      }
      const items = sharedCtx?.items ?? null;
      const createItem = items?.createItem;
      if (!createItem) return { error: 'items.createItem unavailable' };
      let it;
      try { it = createItem(world, { itemId, hue, x, y, z, map: facet, movable: false }); }
      catch (error) { return { error: `static placement failed: ${error?.message ?? error}` }; }
      if (!it?.serial) return { error: 'static placement failed: item factory returned no item' };
      it.isDecoration = true;
      it.script = 'static';
      world.syncSpatialItem?.(it);
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
          try { m.client.send(wi); } catch { /* committed state wins over a stale socket */ }
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
      const x0 = Number(body?.x0), y0 = Number(body?.y0);
      const x1 = Number(body?.x1), y1 = Number(body?.y1);
      const name = String(body?.name ?? '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
      if (!name) return { error: 'name required (alphanumeric)' };
      if (!Number.isInteger(facet) || facet < 0 || facet > 5
          || !Number.isInteger(x0) || !Number.isInteger(y0)
          || !Number.isInteger(x1) || !Number.isInteger(y1)
          || !mapCellInBounds(facet, x0, y0) || !mapCellInBounds(facet, x1, y1)) {
        return { error: 'invalid prefab selection coordinates' };
      }
      // Snap to ascending bounds — operator can pass corners in any order.
      const lx = Math.min(x0, x1), hx = Math.max(x0, x1);
      const ly = Math.min(y0, y1), hy = Math.max(y0, y1);
      const area = (hx - lx + 1) * (hy - ly + 1);
      if (!Number.isSafeInteger(area) || area < 1 || area > 16_384) {
        return { error: 'prefab selection must contain between 1 and 16384 map cells' };
      }
      const includeFixed = !!body?.includeFixed;
      const originZ = mapProvider.landAt(facet, lx, ly)?.z | 0;
      const tiles = [];
      // Runtime items in range — relative offsets so prefab is portable.
      const appendRuntimeItem = (it) => {
        if (!it || it.parent != null) return;
        if ((it.map ?? 1) !== facet) return;
        if (it.x < lx || it.x > hx || it.y < ly || it.y > hy) return;
        tiles.push({
          dx: it.x - lx, dy: it.y - ly, dz: (it.z | 0) - originZ,
          itemId: it.itemId | 0, hue: it.hue | 0, source: 'item',
        });
      };
      const sectorsReady = world?.sectors
        && (world.items.size === 0 || world.sectors.itemsIndexed?.() > 0);
      if (sectorsReady && world.sectors.itemSerialsInRect) {
        for (const serial of world.sectors.itemSerialsInRect(facet, lx, ly, hx, hy)) {
          const item = world.items.get(serial);
          if (item) appendRuntimeItem(item);
          if (tiles.length > 16_384) return { error: 'prefab exceeds the 16384-tile limit' };
        }
      } else {
        for (const item of (world?.items?.values?.() ?? [])) {
          appendRuntimeItem(item);
          if (tiles.length > 16_384) return { error: 'prefab exceeds the 16384-tile limit' };
        }
      }
      if (includeFixed) {
        const fixed = typeof mapProvider.staticsInRect === 'function'
          ? mapProvider.staticsInRect(facet, lx, ly, hx - lx + 1, hy - ly + 1)
          : (function* fallbackStatics() {
            for (let y = ly; y <= hy; y++) for (let x = lx; x <= hx; x++) {
              for (const tile of mapProvider.staticsAt(facet, x, y)) yield { ...tile, x, y };
            }
          }());
        for (const s of fixed) {
          tiles.push({
            dx: s.x - lx, dy: s.y - ly, dz: (s.z | 0) - originZ,
            itemId: s.tileId | 0, hue: s.hue | 0, source: 'static',
          });
          if (tiles.length > 16_384) return { error: 'prefab exceeds the 16384-tile limit' };
        }
      }
      const prefab = {
        version: 2, name, sizeX: hx - lx + 1, sizeY: hy - ly + 1, originZ,
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

  routes.push({
    method: 'GET', path: '/api/statics/prefabs/:name',
    run: ({ params }) => {
      const name = String(params.name ?? '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
      const file = path.join(saveDir, 'prefabs', `${name}.json`);
      if (!name || !fs.existsSync(file)) return { error: 'prefab not found' };
      try {
        const prefab = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ok: true, prefab: { ...prefab, tiles: Array.isArray(prefab.tiles) ? prefab.tiles.slice(0, 16_384) : [] } };
      } catch (error) { return { error: error.message }; }
    },
  });

  routes.push({
    method: 'GET', path: '/api/world-editor/multis',
    run: ({ query }) => {
      const bridge = sharedCtx?.systems?.multiEditor;
      if (!bridge?.catalog) return { error: 'Multi editor bridge is unavailable; reload gameplay scripts.' };
      const kind = String(query.get('kind') ?? 'all').toLowerCase();
      const needle = String(query.get('q') ?? '').trim().toLowerCase().slice(0, 96);
      const offset = queryInt(query, 'offset', 0, 0, 100_000);
      const limit = queryInt(query, 'limit', 100, 1, 500);
      const all = bridge.catalog().filter((entry) => (kind === 'all' || entry.kind === kind)
        && (!needle || `${entry.name} ${entry.id.toString(16)}`.toLowerCase().includes(needle)));
      const owners = [...(world.onlineMobiles?.() ?? [])].filter((mobile) => mobile?.isPlayer !== false)
        .map((mobile) => ({ serial: mobile.serial >>> 0, name: String(mobile.name ?? 'Player').slice(0, 64), map: mobile.map | 0 }));
      return { ok: true, total: all.length, multis: all.slice(offset, offset + limit), owners };
    },
  });
  routes.push({
    method: 'GET', path: '/api/world-editor/multis/:id',
    run: ({ params }) => {
      const multiId = Number(params.id);
      const tiles = sharedCtx?.systems?.multiEditor?.preview?.(multiId);
      return tiles ? { ok: true, multiId, tiles } : { error: 'multi not found' };
    },
  });
  routes.push({
    method: 'POST', path: '/api/world-editor/multis/place',
    run: ({ body, session }) => {
      const ownerSerial = Number(body?.ownerSerial) >>> 0;
      const owner = world.mobiles.get(ownerSerial);
      if (!owner?.client) return { error: 'Select an online owner character.' };
      const result = sharedCtx?.systems?.multiEditor?.place?.(owner, {
        multiId: Number(body?.multiId), hue: Number(body?.hue) | 0,
        x: Number(body?.x) | 0, y: Number(body?.y) | 0,
        z: Math.max(-128, Math.min(127, Number(body?.z) | 0)), map: Number(body?.facet) | 0,
      }) ?? { ok: false, error: 'Multi editor bridge is unavailable.' };
      if (!result.ok) return { error: result.error ?? 'Multi placement failed.' };
      const auditUndoId = registerUndoableMutation(session?.account, 'world-editor.multi-place', {
        multiId: result.multiId, facet: Number(body?.facet) | 0, instanceId: result.serial,
        houseId: result.houseId ?? null,
      });
      return { ...result, auditUndoId };
    },
  });

  // Stamp a saved prefab at (x, y) on the given facet. Items are
  // recreated as runtime items (not the original serials).
  routes.push({
    method: 'POST', path: '/api/statics/import-prefab',
    run: ({ body }) => {
      const name = String(body?.name ?? '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
      const facet = Number(body?.facet ?? 1);
      const baseX = Number(body?.x);
      const baseY = Number(body?.y);
      const requestedZ = body?.z == null ? null : Number(body.z);
      if (!Number.isInteger(facet) || facet < 0 || facet > 5
          || !Number.isInteger(baseX) || !Number.isInteger(baseY)
          || (requestedZ != null && (!Number.isInteger(requestedZ) || requestedZ < -128 || requestedZ > 127))
          || !mapCellInBounds(facet, baseX, baseY)) {
        return { error: 'invalid prefab destination' };
      }
      const baseZ = requestedZ ?? (mapProvider.landAt(facet, baseX, baseY)?.z | 0);
      const file = path.join(saveDir, 'prefabs', `${name}.json`);
      if (!fs.existsSync(file)) return { error: `prefab '${name}' not found` };
      let prefab;
      try { prefab = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { return { error: e.message }; }
      if (!Array.isArray(prefab?.tiles)) return { error: 'prefab has no valid tile array' };
      const sourceTiles = prefab.tiles.filter((tile) => tile?.source !== 'static');
      if (!sourceTiles.length) return { error: 'prefab contains no portable runtime statics' };
      if (sourceTiles.length > 16_384) return { error: 'prefab exceeds the 16384-tile import limit' };
      const td = tileDataTable();
      const staticCount = Math.min(0xc000, td.statics?.length ?? 0);
      const normalized = [];
      for (const tile of sourceTiles) {
        const dx = Number(tile?.dx), dy = Number(tile?.dy);
        const relativeZ = prefab.version >= 2 ? Number(tile?.dz ?? 0) : null;
        const legacyZ = prefab.version >= 2 ? null : Number(tile?.z);
        const itemId = Number(tile?.itemId);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)
            || (prefab.version >= 2 ? !Number.isFinite(relativeZ) : !Number.isFinite(legacyZ))
            || !Number.isInteger(itemId) || itemId < 1 || itemId >= staticCount) {
          return { error: 'prefab contains an invalid tile' };
        }
        const x = baseX + Math.trunc(dx), y = baseY + Math.trunc(dy);
        const rawZ = prefab.version >= 2 ? baseZ + Math.trunc(relativeZ) : Math.trunc(legacyZ);
        if (x < 0 || x > 0xffff || y < 0 || y > 0xffff || rawZ < -128 || rawZ > 127
            || !mapCellInBounds(facet, x, y)) {
          return { error: 'prefab tile falls outside valid world coordinates' };
        }
        normalized.push({ itemId, hue: Number(tile?.hue ?? 0) & 0xffff,
          x, y, z: rawZ, map: facet, movable: false });
      }
      const create = sharedCtx?.items?.createItem;
      const destroy = sharedCtx?.items?.destroyItem;
      if (!create || !destroy) return { error: 'item mutation API unavailable' };
      const newItems = [];
      try {
        for (const row of normalized) {
          const item = create(world, row);
          if (!item?.serial) throw new Error('item factory returned no persistent item');
          item.isDecoration = true; item.script = 'static';
          world.syncSpatialItem?.(item);
          newItems.push(item);
        }
      } catch (error) {
        let rolledBack = 0;
        for (let index = newItems.length - 1; index >= 0; index--) {
          try { if (destroy(world, newItems[index].serial) !== false) rolledBack++; } catch { /* report below */ }
        }
        return { error: `prefab import rolled back: ${error?.message ?? error}`,
          rolledBack, rollbackComplete: rolledBack === newItems.length };
      }
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Broadcast every new item to nearby players in one pass.
      const wiBuilder = sharedCtx?.protocol?.worldItemSA;
      for (const mobile of (world.onlineMobiles?.() ?? world?.mobiles?.values?.() ?? [])) {
        if (!mobile.client || (mobile.map | 0) !== facet) continue;
        for (const item of newItems) {
          if (Math.max(Math.abs(mobile.x - item.x), Math.abs(mobile.y - item.y)) > 18) continue;
          try {
            if (typeof mobile.client.sendItem === 'function') mobile.client.sendItem(item);
            else if (wiBuilder) mobile.client.send(wiBuilder({
              serial: item.serial, itemId: item.itemId, hue: item.hue, amount: 1,
              x: item.x, y: item.y, z: item.z, flags: 0x00,
            }));
          } catch { /* committed state wins over a stale client socket */ }
        }
      }
      return { ok: true, name, placed: newItems.length, total: prefab.tiles.length };
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
      if (it.parent != null) return { error: 'only ground statics can be removed here' };
      if (it._multi != null || it.multiId != null || it.house != null || it.boat != null) {
        return { error: 'use the canonical house/multi removal workflow for this item' };
      }
      if (it.isDecoration !== true && it.script !== 'static') return { error: 'item is not an editor-owned decoration' };
      const x = it.x, y = it.y, facet = it.map;
      const items = sharedCtx?.items ?? null;
      if (!items?.destroyItem) return { error: 'items.destroyItem unavailable' };
      try {
        const removed = items.destroyItem(world, serial);
        if (removed === false || world.items.has(serial)) throw new Error('item remained in the world after removal');
      }
      catch (e) { return { error: e.message }; }
      const rm = sharedCtx?.protocol?.removeEntity?.(serial);
      if (rm) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - x) > 18 || Math.abs(m.y - y) > 18) continue;
          try { m.client.send(rm); } catch { /* committed state wins over a stale socket */ }
        }
      }
      try { invalidateLosCache(); } catch { /* advisory */ }
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
      const staticCount = Math.min(0xc000, td.statics?.length ?? 0);
      const normalized = [];
      for (const row of additions) {
        const itemId = Number(row?.itemId);
        const x = Number(row?.x), y = Number(row?.y), z = Number(row?.z ?? 0);
        if (!Number.isInteger(itemId) || !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)
            || x < 0 || x > 0xffff || y < 0 || y > 0xffff
            || z < -128 || z > 127 || itemId < 1 || itemId >= staticCount
            || !mapCellInBounds(facet, x, y)) return { error: 'invalid addition in batch' };
        normalized.push({ itemId, x, y, z, hue: Number(row?.hue ?? 0) & 0xffff });
      }
      const removalSnapshots = [];
      for (const serial of removals) {
        const item = world.items.get(serial);
        if (!item || item.parent != null) return { error: `removal item 0x${serial.toString(16)} not found on ground` };
        if (item._multi != null || item.multiId != null || item.house != null || item.boat != null) {
          return { error: `removal item 0x${serial.toString(16)} belongs to a canonical multi` };
        }
        if (item.isDecoration !== true && item.script !== 'static') {
          return { error: `removal item 0x${serial.toString(16)} is not an editor-owned decoration` };
        }
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
      try {
        for (const serial of removals) {
          destroy(world, serial);
          if (world.items.has(serial)) throw new Error(`item 0x${serial.toString(16)} remained after removal`);
        }
      } catch (error) {
        for (const item of created) { try { destroy(world, item.serial); } catch {} }
        const restored = [];
        for (const snapshot of removalSnapshots) {
          if (world.items.has(snapshot.serial)) continue;
          try {
            const item = create(world, snapshot);
            if (snapshot.isDecoration) item.isDecoration = true;
            if (snapshot.script != null) item.script = snapshot.script;
            world.syncSpatialItem?.(item);
            restored.push(item);
          } catch { /* surfaced through rollbackComplete */ }
        }
        try { invalidateLosCache(); } catch { /* advisory */ }
        return { error: `batch removal rolled back: ${error?.message ?? error}`,
          rolledBackAdditions: created.length,
          restoredRemovals: restored.length,
          rollbackComplete: removalSnapshots.every((snapshot) => world.items.has(snapshot.serial))
            || restored.length + removalSnapshots.filter((snapshot) => world.items.has(snapshot.serial)).length >= removalSnapshots.length };
      }
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
