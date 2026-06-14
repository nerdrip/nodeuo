// Admin REST API route table. Pure functions: each entry exposes
// `{ method, path, run({ req, params, query, body }) }` and the
// admin-server dispatches on it. Returning a value auto-serializes to
// JSON; returning undefined signals the handler already wrote the
// response (rare — used for binary downloads / streams).
//
// Mutation routes (PATCH/POST/PUT/DELETE) are gated by the admin-server
// auth middleware. GETs are public — list views are safe to expose
// over LAN with no creds, but a bound bind (UO_ADMIN_HOST=0.0.0.0) is
// the operator's choice.

import fs from 'node:fs';
import path from 'node:path';
import { composePaperdoll } from './paperdoll.js';
import { refreshSurroundings } from '../net/handlers.js';
import { landProvider } from '../world/land-provider.js';
import { tileDataTable, resolveStandingZ } from '../world/movement.js';
import { invalidateLosCache } from '../world/los.js';
import { destroyItem } from '../world/items.js';
import { extMapTileEdit } from '@uo/protocol';

export function buildHandlers({ sharedCtx, scriptRuntime, scriptsDir, saveDir, persistence, accounts }) {
  const world = sharedCtx?.world;

  /** Resolve the admin's character mobile(s). Returns array sorted by
   *  slot. Used by every "teleport me" flow so the server picks the
   *  character from the logged-in account, not from a UI-passed serial.
   *
   *  Lookup chain (first hit wins):
   *    1. account.characters[] entries — only populated AFTER the player
   *       finished a CharCreate / CharSelect cycle. Brand-new admin
   *       accounts that only ever logged in via the panel have this
   *       empty.
   *    2. live mobile with matching `mob.accountName` — covers
   *       accounts that played in-game once (mob is stamped at login)
   *       even when the character slot wasn't persisted yet.
   *    3. ANY player-flag mobile owned by an Admin (catches dev / GM
   *       accounts that haven't been bound to an account yet).
   *  We always rank online characters first so prompts default to
   *  whatever the admin is actively playing. */
  function adminCharacters(sessionAccount, preferredSlot) {
    if (!sessionAccount) return [];
    const out = [];
    const seen = new Set();
    const lower = String(sessionAccount).toLowerCase();
    // Path 1 — explicit character slots on the account.
    const acc = accounts?.accounts?.get?.(lower);
    if (acc) {
      for (let i = 0; i < (acc.characters?.length ?? 0); i++) {
        const c = acc.characters[i];
        if (!c) continue;
        const mob = world?.mobiles?.get?.(c.mobileSerial >>> 0);
        out.push({
          slot: i, name: c.name ?? mob?.name ?? '?',
          mobileSerial: c.mobileSerial, mob, online: !!mob?.client,
        });
        seen.add(c.mobileSerial >>> 0);
      }
    }
    // Path 2 — scan world.mobiles for any mob carrying this account name.
    // Helps the very common "I logged in once via the bat, never via
    // CharCreate, but my mob still exists" edge case.
    let seq = out.length;
    for (const mob of (world?.mobiles?.values?.() ?? [])) {
      if (seen.has(mob.serial >>> 0)) continue;
      if (!mob.isPlayer) continue;
      if (String(mob.accountName ?? '').toLowerCase() !== lower) continue;
      out.push({
        slot: seq++, name: mob.name ?? '?',
        mobileSerial: mob.serial >>> 0, mob, online: !!mob.client,
      });
      seen.add(mob.serial >>> 0);
    }
    // Sort online-first so the picker default + auto-tp picks the
    // currently-logged-in character.
    out.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    if (Number.isFinite(preferredSlot)) {
      const found = out.find((c) => c.slot === preferredSlot);
      if (found) return [found];
    }
    return out;
  }

  const routes = [];

  // ---- Dashboard --------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/world/stats',
    run: () => {
      const onlineCount = [...(world?.mobiles?.values?.() ?? [])]
        .filter((m) => !!m.client).length;
      return {
        shard: process.env.UO_SHARD_NAME ?? 'UO-Node',
        uptime: process.uptime() | 0,
        memoryMB: (process.memoryUsage().rss / (1024 * 1024)) | 0,
        mobiles: world?.mobiles?.size ?? 0,
        items: world?.items?.size ?? 0,
        onlinePlayers: onlineCount,
        accounts: accounts?.accounts?.size ?? 0,
        scripts: scriptRuntime?.loaded?.length ?? 0,
        saveDir,
        nodeVersion: process.version,
      };
    },
  });

  routes.push({
    method: 'POST', path: '/api/world/save',
    run: async () => {
      if (!persistence?.requestSave) return { error: 'persistence not wired' };
      const r = await persistence.requestSave(world, saveDir);
      return { ok: true, ...r };
    },
  });

  // Graceful shutdown endpoint — invoked by the control panel
  // BEFORE `taskkill /f` on Windows. Triggers the same SIGINT
  // handler used by Ctrl-C in console mode so the world final-save
  // + houses/bazaar flush + WS close happens cleanly. User report
  // 2026-05-18: "przedmioty z plecaka nie zachowuja się po wyłączeniu
  // servera" — control panel's `taskkill /f` skipped the SIGINT
  // handler entirely, so the 60 s auto-save was the only persistence
  // and anything done since the last tick evaporated.
  //
  // Returns immediately (200 OK) and then schedules the shutdown on
  // the next tick so the response reaches the panel before the
  // process exits.
  routes.push({
    method: 'POST', path: '/api/world/shutdown',
    run: () => {
      setTimeout(() => {
        try { process.kill(process.pid, 'SIGINT'); }
        catch (e) { console.error('[admin] graceful shutdown failed:', e?.message); }
      }, 50);
      return { ok: true, message: 'shutdown signal sent' };
    },
  });

  routes.push({
    method: 'POST', path: '/api/world/broadcast',
    run: ({ body }) => {
      const text = body?.text;
      if (!text || typeof text !== 'string') return { error: 'text required' };
      let count = 0;
      for (const m of (world?.mobiles?.values?.() ?? [])) {
        if (m.client?.sendSystemMessage) {
          m.client.sendSystemMessage(text);
          count++;
        }
      }
      return { ok: true, sentTo: count };
    },
  });

  /**
   * Run a registered admin command (createworld / wipeworld /
   * recreateworld / etc) without an in-game character. Captures
   * sendSystemMessage output into a `messages[]` array so the admin UI
   * can show what happened. Whitelist enforces a small safe set —
   * anything else still requires a player to type `[<cmd>` in-world.
   */
  routes.push({
    method: 'POST', path: '/api/world/cmd',
    run: ({ body, session }) => {
      const SAFE = new Set(['createworld', 'wipeworld', 'recreateworld', 'deleteworld', 'reload']);
      const command = String(body?.command ?? '');
      if (!SAFE.has(command)) return { error: `command not allowed via admin: '${command}'` };
      // Admin audit #8 — destructive verbs require a literal confirm
      // token in the request body. Origin header alone isn't enough if
      // a misconfigured reverse-proxy strips headers — this is a
      // defence-in-depth gate that a benign curl operator must opt
      // into explicitly.
      const DESTRUCTIVE = new Set(['wipeworld', 'deleteworld', 'recreateworld']);
      if (DESTRUCTIVE.has(command) && body?.confirm !== `${command}-yes`) {
        return { error: 'destructive command requires confirm token',
                 expected: `${command}-yes` };
      }
      const commands = sharedCtx?.commands;
      if (!commands?.dispatch) return { error: 'commands registry missing' };
      // Find the admin's character so the command sees a sensible
      // sender (some commands log to the player's chat). Falls back
      // to any online mob if the admin has none.
      const chars = adminCharacters(session?.account);
      const sender = chars.find((c) => c.online)?.mob
                  ?? [...(world?.mobiles?.values?.() ?? [])].find((m) => m.client)
                  ?? null;
      const messages = [];
      const fakeState = {
        sendSystemMessage: (line) => messages.push(String(line)),
        ctx: sharedCtx,
        mobile: sender,
        // Admin REST sessions are always 'Admin' (admin-server.js gates
        // login). Pass it through so the dispatch path's per-command
        // access check (commands.js line 73-79) accepts the call.
        account: { accessLevel: 'Admin', username: session?.account ?? 'admin' },
        accountName: session?.account ?? 'admin',
      };
      const ctx = {
        sender, state: fakeState, world, args: [],
      };
      try {
        const ok = commands.dispatch(command, ctx);
        if (!ok) return { error: `command not registered: '${command}'`, messages };
        return { ok: true, command, messages, sender: sender ? '0x' + (sender.serial >>> 0).toString(16) : null };
      } catch (e) {
        return { error: e.message, messages };
      }
    },
  });

  routes.push({
    method: 'POST', path: '/api/scripts/reload',
    run: async () => {
      if (!scriptRuntime?.load) return { error: 'script runtime not wired' };
      const t0 = Date.now();
      await scriptRuntime.load({ reason: 'admin-api', emitEvent: true });
      return { ok: true, ms: Date.now() - t0, loaded: scriptRuntime.loaded?.length ?? 0 };
    },
  });

  // -------------------------------------------------------------------
  //  Single-script reload — restarts ONE script by relative path
  //  (e.g. `npcs/templates/townspeople.js`). Doesn't touch other
  //  loaded scripts. ScriptRuntime.reloadOne disposes the matching
  //  entry, re-imports the file, and re-runs its default().
  // -------------------------------------------------------------------
  routes.push({
    method: 'POST', path: '/api/scripts/reload-one',
    run: async ({ body }) => {
      const rel = String(body?.rel || '').trim();
      if (!rel) return { error: 'rel script path required (body.rel)' };
      if (!scriptRuntime?.reloadOne) return { error: 'reloadOne unavailable on runtime' };
      const t0 = Date.now();
      const r = await scriptRuntime.reloadOne(rel);
      return { ok: r.ok, ms: Date.now() - t0, ...r };
    },
  });

  // -------------------------------------------------------------------
  //  Data file editor — list / read / write the JSON catalogs under
  //  apps/scripts/src/data/config/ and apps/scripts/src/data/world/.
  //  Used by the admin panel's "Data editor" tab so an operator can
  //  tweak monster stats / NPC archetypes / spawn coords WITHOUT
  //  popping a shell to edit JSON files by hand.
  //
  //  Safety: every write parses the supplied payload as JSON first
  //  (rejects on syntax error), and confines the file path to the
  //  data/ subtree (no parent-dir escape). After write we optionally
  //  trigger scripts:reload so the change goes live.
  // -------------------------------------------------------------------
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
      const facet = Number(query.get('facet') ?? 1);
      const x0 = Number(query.get('x') ?? 1495);
      const y0 = Number(query.get('y') ?? 1625);
      const w = Math.min(64, Math.max(1, Number(query.get('w') ?? 32)));
      const h = Math.min(64, Math.max(1, Number(query.get('h') ?? 32)));
      const tiles = new Array(w * h);
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const t = landProvider.landAt(facet, x0 + dx, y0 + dy);
          tiles[dy * w + dx] = t ? [t.tileId, t.z] : [0, 0];
        }
      }
      return { facet, x: x0, y: y0, w, h, tiles, edits: landProvider.editCount() };
    },
  });

  // Apply a batch of tile edits. Body: { facet, edits: [{x,y,tileId,z}] }.
  routes.push({
    method: 'POST', path: '/api/map/edit',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const edits = Array.isArray(body?.edits) ? body.edits : [];
      if (!edits.length) return { error: 'no edits' };
      let applied = 0;
      // Compute a bounding box of edited tiles so the live-broadcast
      // pass below only re-syncs players actually within range of any
      // change (cheap proxy: refreshSurroundings re-streams the
      // player's full visible chunks).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const e of edits) {
        if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y)) continue;
        landProvider.setLandTile(facet, e.x | 0, e.y | 0, (e.tileId | 0), (e.z | 0));
        if (e.x < minX) minX = e.x; if (e.x > maxX) maxX = e.x;
        if (e.y < minY) minY = e.y; if (e.y > maxY) maxY = e.y;
        applied++;
      }
      // Persist immediately so a server crash doesn't lose the edit
      // session's work. Cheap (sparse JSON) — typically <1ms.
      const r = landProvider.saveEditsSync(path.join(saveDir, 'map-edits.json'));
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
        const editList = edits.map((e) => ({
          x: e.x | 0, y: e.y | 0, tileId: e.tileId | 0, z: e.z | 0,
        }));
        const pkt = extMapTileEdit(facet, editList);
        const cx = (minX + maxX) >> 1;
        const cy = (minY + maxY) >> 1;
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client) continue;
          if (m.map !== facet) continue;
          if (Math.abs(m.x - cx) > 32 || Math.abs(m.y - cy) > 32) continue;
          try { m.client.send(pkt); broadcast++; }
          catch { /* socket transient */ }
        }
      }
      return { ok: true, applied, totalEdits: landProvider.editCount(), broadcast, persist: r };
    },
  });

  // Wipe all overlay edits + delete the persisted file.
  routes.push({
    method: 'POST', path: '/api/map/reset',
    run: () => {
      const all = [...landProvider.iterEdits()];
      for (const e of all) landProvider.clearLandTile(e.facet, e.x, e.y);
      try { fs.unlinkSync(path.join(saveDir, 'map-edits.json')); } catch { /* missing */ }
      return { ok: true, cleared: all.length };
    },
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
      const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 80)));
      const td = tileDataTable();
      const matches = [];
      // tiledata.statics is indexed by GLOBAL art id (LAND_COUNT + local).
      // Callers (palette, /api/statics/place, runtime item.itemId) all use
      // LOCAL static ids. Subtract LAND_COUNT when emitting so the wire
      // contract stays LOCAL-only and the editor's atlas lookup adds the
      // offset itself when fetching sprites.
      const LAND_COUNT = (td.land?.length ?? 16384) | 0;
      const trySource = (arr, type) => {
        const idShift = type === 'static' ? LAND_COUNT : 0;
        for (let i = 0; i < arr.length; i++) {
          if (matches.length >= limit) break;
          const e = arr[i];
          if (!e) continue;
          const name = String(e.name ?? '').toLowerCase();
          if (!name) continue;
          if (name === 'nodraw') continue;
          const outId = i - idShift;
          if (outId < 0) continue;
          // Empty query → first N. Numeric query → match by id (hex/decimal).
          if (q === '') {
            matches.push({ type, id: outId, name: e.name, height: e.height | 0, layer: e.layer | 0 });
            continue;
          }
          if (/^0x[0-9a-f]+$/i.test(q)) {
            // Accept either local (matches outId) or global (matches i)
            // hex queries so power users can paste either.
            const want = parseInt(q, 16);
            if (outId === want || i === want) {
              matches.push({ type, id: outId, name: e.name, height: e.height | 0, layer: e.layer | 0 });
            }
            continue;
          }
          if (/^\d+$/.test(q)) {
            const want = parseInt(q, 10);
            if (outId === want || i === want) {
              matches.push({ type, id: outId, name: e.name, height: e.height | 0, layer: e.layer | 0 });
            }
            continue;
          }
          if (name.includes(q)) {
            matches.push({ type, id: outId, name: e.name, height: e.height | 0, layer: e.layer | 0 });
          }
        }
      };
      if (kind === 'land' || kind === 'all') trySource(td.land ?? [], 'land');
      if (kind === 'static' || kind === 'all') trySource(td.statics ?? [], 'static');
      return { q, kind, count: matches.length, matches };
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
      for (const e of landProvider.iterEdits()) {
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
      const facet = Number(query.get('facet') ?? 1);
      const x0 = Number(query.get('x') ?? 1495);
      const y0 = Number(query.get('y') ?? 1625);
      const w = Math.min(64, Math.max(1, Number(query.get('w') ?? 32)));
      const h = Math.min(64, Math.max(1, Number(query.get('h') ?? 32)));
      // Map of `${dx}|${dy}` → array of {tileId, z, hue, source} where
      // source is 'static' (from chunk static layer, fixed) or 'item'
      // (from world.items, mutable via [del / build).
      const cells = {};
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const wx = x0 + dx, wy = y0 + dy;
          const stack = [];
          for (const s of landProvider.staticsAt(facet, wx, wy)) {
            stack.push({ tileId: s.tileId, z: s.z, hue: s.hue, source: 'static' });
          }
          // Now overlay world.items at (wx, wy, facet)
          for (const it of (world?.items?.values?.() ?? [])) {
            if (it.parent != null) continue;        // worn / contained — skip
            if (it.x !== wx || it.y !== wy || (it.map ?? 1) !== facet) continue;
            stack.push({
              tileId: it.itemId, z: it.z, hue: it.hue ?? 0,
              source: 'item', serial: '0x' + (it.serial >>> 0).toString(16),
            });
          }
          if (stack.length) cells[`${dx}|${dy}`] = stack;
        }
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
      if (!itemId || itemId < 1 || itemId > 0x4000) return { error: `bad itemId 0x${itemId.toString(16)}` };
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
            for (const s of landProvider.staticsAt(facet, x, y)) {
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

  // ---- Accounts ---------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/accounts',
    run: () => {
      const list = [...(accounts?.accounts?.values?.() ?? [])].map((a) => ({
        username: a.username,
        accessLevel: a.accessLevel,
        banned: !!a.banned,
        created: a.created,
        lastLogin: a.lastLogin,
        characters: (a.characters ?? []).filter(Boolean).length,
      }));
      return { count: list.length, accounts: list };
    },
  });

  routes.push({
    method: 'GET', path: '/api/accounts/:name',
    run: ({ params }) => {
      const acc = accounts?.accounts?.get(params.name.toLowerCase());
      if (!acc) return { error: 'not found' };
      const safe = { ...acc };
      delete safe.hash;
      // Resolve character serials → mob snapshots so the UI shows live state.
      const chars = (acc.characters ?? []).map((c) => {
        if (!c) return null;
        const mob = world?.mobiles?.get?.(c.mobileSerial >>> 0);
        return {
          ...c,
          live: mob ? snapshotMobile(mob) : null,
        };
      });
      return { ...safe, characters: chars };
    },
  });

  routes.push({
    method: 'PATCH', path: '/api/accounts/:name',
    run: ({ params, body, session }) => {
      const acc = accounts?.accounts?.get(params.name.toLowerCase());
      if (!acc) return { error: 'not found' };
      // Admin audit #1/#2/#5 — stored XSS via accessLevel class +
      // privilege escalation. Whitelist the values + refuse self-edit
      // on accessLevel/banned (no admin can de-Admin themselves or
      // re-Admin themselves silently).
      const ALLOWED_LEVELS = new Set(['Player', 'Counselor', 'Seer', 'GameMaster', 'GM', 'Admin']);
      const isSelf = session?.account
        && session.account.username?.toLowerCase() === params.name.toLowerCase();
      if (body && 'accessLevel' in body) {
        if (!ALLOWED_LEVELS.has(body.accessLevel)) {
          return { error: 'invalid accessLevel' };
        }
        if (isSelf) return { error: 'cannot change your own accessLevel' };
        acc.accessLevel = body.accessLevel;
      }
      if (body && 'banned' in body) {
        if (isSelf && body.banned) return { error: 'cannot ban self' };
        acc.banned = !!body.banned;
      }
      accounts.saveSync();
      return { ok: true, account: { username: acc.username, accessLevel: acc.accessLevel, banned: !!acc.banned } };
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/accounts/:name',
    run: ({ params }) => {
      const key = params.name.toLowerCase();
      const ok = accounts?.accounts?.delete(key);
      if (ok) accounts.saveSync();
      return { ok: !!ok };
    },
  });

  // ---- Mobiles (characters + NPCs) -------------------------------------
  routes.push({
    method: 'GET', path: '/api/mobiles',
    run: ({ query }) => {
      const filter = (query.get('filter') ?? '').toLowerCase();
      const onlyPlayers = query.get('players') === '1';
      const limit = Math.min(500, Number(query.get('limit') ?? 200));
      const offset = Number(query.get('offset') ?? 0);
      const all = [...(world?.mobiles?.values?.() ?? [])];
      const filtered = all.filter((m) => {
        if (onlyPlayers && !m.client && !m.isPlayer) return false;
        if (!filter) return true;
        return (m.name ?? '').toLowerCase().includes(filter)
          || `0x${(m.serial >>> 0).toString(16)}`.includes(filter);
      });
      return {
        count: filtered.length,
        mobiles: filtered.slice(offset, offset + limit).map(snapshotMobile),
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/mobiles/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      // Pull worn items + backpack contents for the preview pane.
      // Reverse parent index: ≤10 worn slots + ≤30 pack contents
      // instead of two full 110k walks per request. Bug-hunt #4 A5.
      const equipped = [];
      let backpack = null;
      const idx = world?._childrenByParent;
      const wornIter = idx?.get?.(mob.serial)
        ? Array.from(idx.get(mob.serial), (s) => world.items.get(s)).filter(Boolean)
        : [...(world?.items?.values?.() ?? [])].filter((it) => it.parent === mob.serial);
      for (const it of wornIter) {
        if (it.layer === 21) backpack = it;
        if ((it.layer ?? 0) > 0) equipped.push({
          serial: '0x' + (it.serial >>> 0).toString(16),
          itemId: it.itemId, hue: it.hue, layer: it.layer, name: it.name,
        });
      }
      const packIter = backpack
        ? (idx?.get?.(backpack.serial)
            ? Array.from(idx.get(backpack.serial), (s) => world.items.get(s)).filter(Boolean)
            : [...world.items.values()].filter((it) => it.parent === backpack.serial))
        : [];
      const packContents = packIter.map((it) => ({
        serial: '0x' + (it.serial >>> 0).toString(16),
        itemId: it.itemId, hue: it.hue, amount: it.amount, name: it.name,
      }));
      return {
        ...snapshotMobile(mob),
        equipped,
        backpackContents: packContents,
      };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/teleport',
    run: ({ params, body }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      const x = Number(body?.x), y = Number(body?.y), z = Number(body?.z ?? mob.z);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x,y required' };
      mob.x = x; mob.y = y; mob.z = z;
      if (Number.isFinite(body?.map)) mob.map = body.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/kill',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      mob.hp = 0;
      // Bug-hunt #10 #3 — `combat.damage` only adjusts HP; the death
      // path (corpse spawn, notoriety, mob.delete) lives in
      // `corpse.killMobile`. Without this admin "kill" left passive
      // NPCs frozen at HP=0 forever. Try direct call first; fall back
      // to the combat path so any in-flight combat tick still wraps
      // the death via its own damage closure.
      const killMobile = sharedCtx?.corpse?.killMobile
                      ?? sharedCtx?.systems?.corpse?.killMobile;
      if (typeof killMobile === 'function') {
        try { killMobile(world, mob, null); }
        catch (e) { console.error('[admin] kill threw:', e); }
      } else {
        sharedCtx?.handlers?.combat?.damage?.(world, mob, 9999, null);
      }
      return { ok: true };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/kick',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob?.client) return { error: 'not online' };
      try { mob.client.close?.(); } catch { /* ignore */ }
      return { ok: true };
    },
  });

  // ---- Items ------------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/items',
    run: ({ query }) => {
      const filter = (query.get('filter') ?? '').toLowerCase();
      const onGround = query.get('ground') === '1';
      const limit = Math.min(500, Number(query.get('limit') ?? 200));
      const offset = Number(query.get('offset') ?? 0);
      const all = [...(world?.items?.values?.() ?? [])];
      const filtered = all.filter((it) => {
        if (onGround && it.parent != null) return false;
        if (!filter) return true;
        return (it.name ?? '').toLowerCase().includes(filter)
          || `0x${(it.itemId | 0).toString(16)}`.includes(filter)
          || `0x${(it.serial >>> 0).toString(16)}`.includes(filter);
      });
      return {
        count: filtered.length,
        items: filtered.slice(offset, offset + limit).map(snapshotItem),
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/items/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'not found' };
      return snapshotItem(it);
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/items/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'not found' };
      // Bug-hunt #10 #2: was a raw `world.items.delete(serial)` which
      // bypassed reverse-index unlink + sector removal + child orphan
      // sweep + removeEntity broadcast. Use `destroyItem` so observers
      // immediately stop seeing the item and persistence stays clean.
      destroyItem(world, serial);
      return { ok: true };
    },
  });

  // ---- "Teleport ME" — server picks the admin's character ---------------
  //
  // Marcin's request: stop asking the UI for a mobile serial. The admin
  // is logged in, the server knows their account, look up the
  // characters there. If exactly one → teleport it. If more → return
  // 409 + the list so the UI shows a tiny picker modal.
  routes.push({
    method: 'POST', path: '/api/me/teleport',
    run: ({ session, body }) => {
      const chars = adminCharacters(session?.account, Number(body?.slot));
      if (!chars.length) return { error: 'no characters on this admin account' };
      if (chars.length > 1 && body?.slot == null) {
        return { needsPick: true, characters: chars.map((c) => ({
          slot: c.slot, name: c.name, mobileSerial: '0x' + (c.mobileSerial >>> 0).toString(16),
          online: c.online,
        })) };
      }
      const target = chars[0];
      if (!target.mob) return { error: `character "${target.name}" has no live mobile (offline?)` };
      // Resolve destination — three modes: explicit (x,y,z,map),
      // anchor item, anchor spawner. Picked by which body field is set.
      const mob = target.mob;
      let dest = null;
      if (body?.itemSerial) {
        const it = world?.items?.get?.(parseSerial(body.itemSerial));
        if (!it) return { error: 'item not found' };
        let anchor = it; let hops = 0;
        while (anchor.parent && hops++ < 8) {
          const p = world?.items?.get?.(anchor.parent)
                 ?? world?.mobiles?.get?.(anchor.parent);
          if (!p) break; anchor = p;
        }
        dest = { x: anchor.x | 0, y: anchor.y | 0, z: anchor.z | 0, map: anchor.map };
      } else if (body?.spawnerId) {
        const g = sharedCtx?.spawner?.groups?.get?.(body.spawnerId);
        if (!g?.rect) return { error: 'spawner not found' };
        dest = {
          x: ((g.rect.x1 + g.rect.x2) / 2) | 0,
          y: ((g.rect.y1 + g.rect.y2) / 2) | 0,
          z: 0, map: g.map,
        };
      } else if (Number.isFinite(body?.x) && Number.isFinite(body?.y)) {
        dest = { x: body.x | 0, y: body.y | 0, z: (body.z | 0) || mob.z, map: body.map };
      } else {
        return { error: 'pass itemSerial OR spawnerId OR (x,y[,z,map])' };
      }
      // Resolve standing Z so the admin doesn't end up at z=0 inside
      // the foundation of a multi-story building (Britain Bank floor
      // sits at z=20, etc.). Map editor / Static editor send z:0 by
      // convention — we substitute the proper standing z here so the
      // avatar lands ON the visible floor instead of underneath the
      // map. Skip the substitution when caller passed an explicit
      // non-zero z (item / spawner anchors carry meaningful z).
      if ((body?.z | 0) === 0 && (body?.x != null || body?.spawnerId)) {
        try {
          const standZ = resolveStandingZ(dest.map ?? mob.map ?? 1, dest.x, dest.y, dest.z);
          if (Number.isFinite(standZ)) dest.z = standZ;
        } catch { /* fall back to z=0 */ }
      }
      // CRITICAL: just mutating mob.x/y/z server-side leaves the
      // player's client + every nearby observer staring at the OLD
      // tile until the next 0x77 broadcast. Mirror what `[go` (the
      // canonical teleport command) does — remove from pre-observers,
      // update self, broadcast moving to post-observers.
      const protocol = sharedCtx?.protocol;
      const removeEntity = protocol?.removeEntity;
      const mobileUpdate = protocol?.mobileUpdate;
      const mobileMoving = protocol?.mobileMoving;
      const oldMap = mob.map;
      // Pre-observers: anyone within 18 tiles on the SAME map before
      // the move. They get a removeEntity packet.
      const preObservers = [];
      for (const m of world.mobiles.values()) {
        if (!m.client || m === mob) continue;
        if (m.map !== oldMap) continue;
        if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
        preObservers.push(m);
      }
      if (removeEntity) {
        const rm = removeEntity(mob.serial);
        for (const m of preObservers) m.client.send(rm);
      }
      mob.x = dest.x & 0xffff;
      mob.y = dest.y & 0xffff;
      mob.z = (dest.z | 0);
      if (Number.isFinite(dest.map)) mob.map = dest.map | 0;
      world?.sectors?.moveMobile?.(mob);
      // Self: mobileUpdate so the player's client snaps to the new
      // position (and re-requests nearby chunks via the normal flow).
      if (mob.client && mobileUpdate) {
        mob.client.send(mobileUpdate({
          serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0,
          x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
        }));
      }
      // Post-observers: anyone now within 18 tiles on the new map.
      if (mobileMoving) {
        const moving = mobileMoving({
          serial: mob.serial, body: mob.body,
          x: mob.x, y: mob.y, z: mob.z,
          direction: mob.direction ?? 0, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
        });
        for (const m of world.mobiles.values()) {
          if (!m.client || m === mob) continue;
          if (m.map !== mob.map) continue;
          if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
          m.client.send(moving);
        }
      }
      // Push every nearby mob/item back to the teleporter — without this,
      // they snap to the new tile but see an empty viewport (the spawn
      // rect's mobs are server-side, but no client packet announces them
      // until the next 0x77 broadcast). Same code path as 0x22 resync.
      try { if (mob.client) refreshSurroundings(mob.client); }
      catch (e) { console.error('[admin/teleport] refreshSurroundings:', e.message); }
      return {
        ok: true, character: target.name, mobileSerial: '0x' + (mob.serial >>> 0).toString(16),
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      };
    },
  });

  // Teleport ANY mobile to the location of an item. The item may be on the
  // ground (uses item.x/y/z) or worn / contained — in those cases we walk
  // the parent chain to find the eventual ground anchor (the worn-by mobile
  // or the chest's ground tile). Body: `{ mobileSerial: '0x...' }`.
  routes.push({
    method: 'POST', path: '/api/items/:serial/teleport',
    run: ({ params, body }) => {
      const itemSerial = parseSerial(params.serial);
      const mobSerial  = parseSerial(body?.mobileSerial);
      const it = world?.items?.get?.(itemSerial);
      if (!it) return { error: 'item not found' };
      const mob = world?.mobiles?.get?.(mobSerial);
      if (!mob) return { error: 'mobile not found (pass mobileSerial as 0x... in body)' };
      // Resolve to a ground tile by walking parent chain. A worn item's
      // "position" is the wearer's tile; a chest-contained item's
      // position is the chest's tile (which may itself be worn — keep
      // walking, max 8 hops to avoid pathological cycles).
      let anchor = it; let hops = 0;
      while (anchor.parent && hops++ < 8) {
        const p = world?.items?.get?.(anchor.parent)
               ?? world?.mobiles?.get?.(anchor.parent);
        if (!p) break;
        anchor = p;
      }
      if (!Number.isFinite(anchor?.x) || !Number.isFinite(anchor?.y)) {
        return { error: 'item has no resolvable ground position' };
      }
      mob.x = anchor.x | 0;
      mob.y = anchor.y | 0;
      mob.z = anchor.z | 0;
      if (Number.isFinite(anchor.map)) mob.map = anchor.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
               anchorKind: anchor === it ? 'item' : 'parent' };
    },
  });

  // ---- Scripts (read / edit / create / delete) -------------------------
  routes.push({
    method: 'GET', path: '/api/scripts',
    run: () => {
      const tree = walkScriptTree(scriptsDir);
      return { root: scriptsDir, tree };
    },
  });

  routes.push({
    method: 'GET', path: '/api/scripts/file',
    run: ({ query }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(scriptsDir, rel);
      if (!abs) return { error: 'bad path' };
      try {
        const content = fs.readFileSync(abs, 'utf8');
        const stat = fs.statSync(abs);
        return { path: rel, size: stat.size, mtime: stat.mtime, content };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/scripts/file',
    run: ({ query, body }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(scriptsDir, rel);
      if (!abs) return { error: 'bad path' };
      if (typeof body?.content !== 'string') return { error: 'content (string) required' };
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body.content, 'utf8');
        return { ok: true, path: rel, size: body.content.length };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/scripts/file',
    run: ({ query }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(scriptsDir, rel);
      if (!abs) return { error: 'bad path' };
      try {
        fs.unlinkSync(abs);
        return { ok: true, path: rel };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  // ---- Spawners ---------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/spawners',
    run: () => {
      const groups = sharedCtx?.spawner?.groups;
      const list = groups ? [...groups.values()].map((g) => ({
        id: g.id, map: g.map, rect: g.rect,
        kinds: g.kinds, maxCount: g.maxCount,
        active: g.spawnedSerials?.size ?? 0,
        respawnMs: g.respawnMs,
        // Pre-computed center so the UI's "tp here" button doesn't need
        // to know the rect math. Floor to integer tile.
        center: g.rect ? {
          x: ((g.rect.x1 + g.rect.x2) / 2) | 0,
          y: ((g.rect.y1 + g.rect.y2) / 2) | 0,
        } : null,
      })) : [];
      return { count: list.length, spawners: list };
    },
  });

  // Add OR replace a spawner — POST /api/spawners with the full group
  // payload. Body shape mirrors `Spawner.add()`:
  //   { id, map, rect:{x1,y1,x2,y2}, kinds:[...], maxCount,
  //     respawnMs:[lo,hi], proximityRange?, homeRange?, team? }
  routes.push({
    method: 'POST', path: '/api/spawners',
    run: ({ body }) => {
      const sp = sharedCtx?.spawner;
      if (!sp) return { error: 'spawner subsystem not wired' };
      const g = body ?? {};
      if (!g.id || typeof g.id !== 'string') return { error: 'id required (string)' };
      if (!g.rect || !Number.isFinite(g.rect.x1)) return { error: 'rect required {x1,y1,x2,y2}' };
      if (!Array.isArray(g.kinds) || g.kinds.length === 0) return { error: 'kinds required' };
      // Validate respawn bounds; the Spawner constructor swaps if reversed.
      if (!Array.isArray(g.respawnMs)) g.respawnMs = [30_000, 120_000];
      g.maxCount = Math.max(1, Math.min(50, (g.maxCount | 0) || 5));
      g.map = (g.map | 0) || 1;
      sp.groups.delete(g.id);    // replace semantics
      sp.add(g);
      return { ok: true, id: g.id };
    },
  });

  // Remove a spawner by id. Active mobs are NOT despawned — they live
  // out their normal lifecycle (death / decay). Matches ServUO's
  // `Spawner.OnDelete` behaviour.
  routes.push({
    method: 'DELETE', path: '/api/spawners/:id',
    run: ({ params }) => {
      const sp = sharedCtx?.spawner;
      if (!sp) return { error: 'spawner subsystem not wired' };
      const had = sp.groups.has(params.id);
      sp.remove(params.id);
      return { ok: had, id: params.id };
    },
  });

  // Enumerate spawnable monster kinds — fuels the "Add Spawner" modal
  // dropdown in the ISO editor. The monsters registry is the source of
  // truth for which `kind` strings the spawner.factory will resolve.
  routes.push({
    method: 'GET', path: '/api/monster-kinds',
    run: () => {
      const monsters = sharedCtx?.monsters;
      if (!monsters?.kinds) return { count: 0, kinds: [] };
      const kinds = monsters.kinds().map((k) => {
        const cfg = monsters.get(k) ?? {};
        return {
          kind: k,
          name: cfg.name ?? k,
          body: cfg.body ?? null,
          fame: cfg.fame ?? 0,
          // Classification hint for the modal's color-coded label —
          // matches the editor.html spawner-overlay classifier so the
          // dropdown UI can mirror the admin map's red/green coding.
          tier: cfg.fame >= 18000 ? 'boss'
              : cfg.fame >= 8000  ? 'paragon'
              : cfg.fame >= 1500  ? 'monster'
              : cfg.tameable      ? 'tame'
              : 'fauna',
        };
      });
      return { count: kinds.length, kinds };
    },
  });

  // Teleport a mob to the geometric centre of a spawner rect.
  routes.push({
    method: 'POST', path: '/api/spawners/:id/teleport',
    run: ({ params, body }) => {
      const groups = sharedCtx?.spawner?.groups;
      const g = groups?.get?.(params.id);
      if (!g || !g.rect) return { error: 'spawner not found / no rect' };
      const mobSerial = parseSerial(body?.mobileSerial);
      const mob = world?.mobiles?.get?.(mobSerial);
      if (!mob) return { error: 'mobile not found (pass mobileSerial 0x...)' };
      mob.x = ((g.rect.x1 + g.rect.x2) / 2) | 0;
      mob.y = ((g.rect.y1 + g.rect.y2) / 2) | 0;
      mob.z = 0;
      if (Number.isFinite(g.map)) mob.map = g.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map, spawner: g.id };
    },
  });

  // Paperdoll preview — composes the equipped layers on top of the
  // body silhouette into a single PNG so the admin UI can <img src=...>
  // it inline. Returns a 260×324 PNG (CUO paperdoll dims).
  // Layer order matches CUO `PaperDollInteractable` — back-most first.
  routes.push({
    method: 'GET', path: '/api/mobiles/:serial/paperdoll',
    run: async ({ params, res }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return undefined;
      }
      try {
        const png = await composePaperdoll(world, mob);
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-cache',
        });
        res.end(png);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return undefined;
    },
  });

  // ---- Logs (in-memory ring buffer; buildHandlers caller wires this) ---
  routes.push({
    method: 'GET', path: '/api/logs',
    run: () => {
      return { lines: getLogTail() };
    },
  });

  // ---- Data editor (read/write JSON config under apps/scripts/src/data) ----
  // Every route below is gated by `safeJoinData()` which refuses paths
  // escaping `apps/scripts/src/data/` via `..` or absolute resolution.
  // Writes always drop a `<file>.bak.<ts>` next to the target before
  // overwriting so the operator can roll back a bad edit. Reuses the
  // `DATA_ROOT` const declared higher up by the legacy textarea-editor
  // routes — duplicating it threw `SyntaxError: Identifier 'DATA_ROOT'
  // already declared` on boot.
  function safeJoinData(rel) {
    if (typeof rel !== 'string' || !rel) return null;
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (norm.includes('..')) return null;
    if (!/\.json$/i.test(norm)) return null;
    const abs = path.resolve(DATA_ROOT, norm);
    if (!abs.startsWith(DATA_ROOT + path.sep) && abs !== DATA_ROOT) return null;
    return abs;
  }
  function walkDataTree(dir, base = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ type: 'dir', name: e.name, path: rel, children: walkDataTree(path.join(dir, e.name), rel) });
      } else if (e.isFile() && /\.json$/i.test(e.name)) {
        let size = 0; let mtime = 0;
        try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs | 0; }
        catch { /* ignore */ }
        out.push({ type: 'file', name: e.name, path: rel, size, mtime });
      }
    }
    out.sort((a, b) => {
      // Directories first, then files; alphabetical within group.
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  // Note: there are pre-existing /api/data/{files,file} routes higher
  // up that power the legacy textarea editor (flat file list + raw
  // string content). The /api/data-tree/* family below is the parsed/
  // structured variant for the new tree-view visual editor: it returns
  // an actual nested directory tree plus a parsed JSON value (vs raw
  // string) so the client doesn't have to re-parse on every open and
  // PUTs come with a five-deep backup rotation.
  routes.push({
    method: 'GET', path: '/api/data-tree/files',
    run: () => ({ root: 'apps/scripts/src/data', tree: walkDataTree(DATA_ROOT) }),
  });

  routes.push({
    method: 'GET', path: '/api/data-tree/file',
    run: ({ query }) => {
      const abs = safeJoinData(query?.get?.('path'));
      if (!abs) return { error: 'invalid path (must be under apps/scripts/src/data/*.json)' };
      try {
        const text = fs.readFileSync(abs, 'utf8');
        const data = JSON.parse(text);
        const st = fs.statSync(abs);
        return { path: query.get('path'), size: st.size, mtime: st.mtimeMs | 0, data };
      } catch (e) {
        return { error: `read failed: ${e.message}` };
      }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/data-tree/file',
    run: ({ query, body }) => {
      const abs = safeJoinData(query?.get?.('path'));
      if (!abs) return { error: 'invalid path (must be under apps/scripts/src/data/*.json)' };
      if (body == null) return { error: 'missing JSON body' };
      const data = body?.data;
      if (data === undefined) return { error: 'body.data required (the JSON value to persist)' };
      try {
        // Round-trip through JSON.stringify to guarantee deterministic
        // output + reject NaN/Infinity/functions sneaking through the
        // PUT (those would throw on next server boot).
        const text = JSON.stringify(data, null, body?.pretty === false ? 0 : 2);
        // Backup before overwrite — keeps the last 5 versions so the
        // operator can compare a regression without git history.
        try {
          if (fs.existsSync(abs)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const bak = `${abs}.bak.${ts}`;
            fs.copyFileSync(abs, bak);
            // Prune older backups beyond 5 keepers.
            const dir = path.dirname(abs);
            const base = path.basename(abs);
            const bakRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.bak\\.`);
            const baks = fs.readdirSync(dir)
              .filter((f) => bakRe.test(f))
              .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
              .sort((a, b) => b.t - a.t);
            for (const b of baks.slice(5)) {
              try { fs.unlinkSync(path.join(dir, b.f)); } catch { /* ignore */ }
            }
          }
        } catch { /* backup failed — proceed with write anyway */ }
        fs.writeFileSync(abs, text, 'utf8');
        const st = fs.statSync(abs);
        return { ok: true, path: query.get('path'), size: st.size, mtime: st.mtimeMs | 0 };
      } catch (e) {
        return { error: `write failed: ${e.message}` };
      }
    },
  });

  return routes;
}

// ---- snapshot helpers ----------------------------------------------------

function snapshotMobile(mob) {
  return {
    serial: '0x' + (mob.serial >>> 0).toString(16),
    name: mob.name,
    body: mob.body,
    hue: mob.hue,
    x: mob.x, y: mob.y, z: mob.z, map: mob.map,
    direction: mob.direction,
    notoriety: mob.notoriety,
    hp: mob.hp, hpMax: mob.hpMax,
    mana: mob.mana, manaMax: mob.manaMax,
    stam: mob.stam, stamMax: mob.stamMax,
    str: mob.str, dex: mob.dex, int: mob.int,
    gold: mob.gold,
    sex: mob.sex,
    isPlayer: !!mob.isPlayer,
    online: !!mob.client,
    accountName: mob.accountName,
    // Civic-NPC tag exposed for the admin "Vendors" filter — without
    // it the UI couldn't tell a banker from a wild orc and the
    // operator's "where are my shopkeepers" lookup blended into the
    // monster list.
    vendorKind: mob.vendorKind ?? null,
    kind: mob.kind ?? null,
  };
}

function snapshotItem(it) {
  return {
    serial: '0x' + (it.serial >>> 0).toString(16),
    itemId: it.itemId, hue: it.hue, amount: it.amount,
    x: it.x, y: it.y, z: it.z, map: it.map,
    parent: it.parent ? '0x' + (it.parent >>> 0).toString(16) : null,
    layer: it.layer,
    name: it.name,
    movable: it.movable,
    gumpId: it.gumpId,
  };
}

function parseSerial(s) {
  if (!s) return 0;
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16) >>> 0;
  return Number(s) >>> 0;
}

function safeJoin(root, rel) {
  if (!rel) return null;
  // Reject path traversal.
  const normalized = path.normalize(rel).replace(/^[/\\]+/, '');
  if (normalized.includes('..')) return null;
  const abs = path.join(root, normalized);
  if (!abs.startsWith(root)) return null;
  return abs;
}

function walkScriptTree(dir, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: rel, children: walkScriptTree(path.join(dir, e.name), rel) });
    } else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
      out.push({ type: 'file', name: e.name, path: rel, size });
    }
  }
  return out;
}

// Tiny ring buffer hooked from main.js via `attachLogHook(line)`.
const LOG_RING = [];
const LOG_MAX = 500;
export function pushLogLine(line) {
  LOG_RING.push({ ts: Date.now(), line: String(line).slice(0, 1024) });
  while (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}
function getLogTail() { return LOG_RING.slice(-200); }
