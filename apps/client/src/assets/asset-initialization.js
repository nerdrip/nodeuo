import { Assets } from 'pixi.js';
import { bus } from '../core/event-bus.js';
import { setSharedHueLut } from '../renderer/hue-filter.js';
import { fetchJson, fetchJsonOptional } from './asset-fetch.js';

const BASE = '/assets';
const ATLAS_BOOT_PRELOAD_CONCURRENCY = 4;
const ATLAS_BOOT_STATIC_PAGE_LIMIT = 2;
const ATLAS_BOOT_MOBILE_PAGE_LIMIT = 2;
const EAGER_MOBILE_BODIES = Object.freeze([
  0x0190, 0x0191, 0x0192, 0x0193,
  0x000C, 0x000D, 0x00C8, 0x00E2, 0x00E4, 0x00CC, 0x0035,
]);

async function loadMobileAtlasRoot() {
  const index = await fetchJsonOptional(`${BASE}/mobiles-atlas-index.json`);
  if (index?.format === 'nodeuo.mobile-atlas-shards'
    && (index.schemaVersion | 0) >= 4
    && Number.isInteger(index.shardSize)
    && index.shards && typeof index.shards === 'object') {
    return { ...index, bodies: {} };
  }
  return fetchJsonOptional(`${BASE}/mobiles-atlas.json`);
}

/** Load only assets required by the account/character-selection shell. The previous
 *  boot path fetched the complete map, statics and mobile animation
 *  catalogue before showing the account form (~188 MB on a clean cache). */
export async function initializeLogin(manager, opts = {}) {
  if (manager._loginReady) return;
  if (manager._loginInitPromise) return manager._loginInitPromise;
  const onProgress = opts.onProgress ?? (() => {});
  manager._loginInitPromise = (async () => {
    onProgress(0, 'login manifests');
    const [cursorsManifest] = await Promise.all([
      manager.cursorsManifest ?? fetchJsonOptional(`${BASE}/cursors.json`),
    ]);
    manager.cursorsManifest = cursorsManifest;
    if (cursorsManifest && !manager.cursorsImage) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { try { bus?.emit?.('cursors:ready'); } catch { /* ignore */ } };
      img.src = `${BASE}/${cursorsManifest.atlas ?? 'cursors-atlas.png'}`;
      manager.cursorsImage = img;
    }
    manager._loginReady = true;
    onProgress(1, 'login ready');
  })();
  try { await manager._loginInitPromise; }
  finally { manager._loginInitPromise = null; }
}

/** Character creation is uncommon compared with ordinary login. Load its
 *  8+ MB tile metadata and paperdoll atlas only after the user opens the
 *  creation flow, not for every returning player. */
export async function initializeCharacterCreation(manager) {
  if (manager._characterCreationReady) return;
  if (!manager._characterCreationInitPromise) {
    manager._characterCreationInitPromise = Promise.all([
      manager.tiledata ?? fetchJson(`${BASE}/tiledata.json`),
      manager.gumpAtlas ?? fetchJsonOptional(`${BASE}/gump-atlas.json`),
      manager.professions ?? fetchJsonOptional(`${BASE}/professions.json`),
    ]).then(([tiledata, gumpAtlas, professions]) => {
      manager.tiledata = tiledata;
      manager.gumpAtlas = gumpAtlas;
      manager.professions = professions;
      manager._characterCreationReady = true;
    });
  }
  try { await manager._characterCreationInitPromise; }
  finally { if (!manager._characterCreationReady) manager._characterCreationInitPromise = null; }
}

/** Load the complete in-world asset graph. Idempotent and shared across
 *  character-selection prefetch, GameScene and reconnects. */
export async function initializeWorld(manager, opts = {}) {
  if (manager._worldReady) return;
  if (!manager._worldInitPromise) {
    manager._worldInitPromise = manager._initWorld(opts).then(() => { manager._worldReady = true; });
  }
  try { await manager._worldInitPromise; }
  finally { if (!manager._worldReady) manager._worldInitPromise = null; }
}

/** Load the small upfront stuff: manifests + hues palette texture. */
/**
 * Boot the asset cache. Pass `{ onProgress(pct, label) }` to receive
 * load events — `pct` is 0..1, `label` is a short human-readable
 * stage name (e.g. "tiledata", "atlas pages"). Splash screens use
 * this to drive a progress bar.
 *
 * @param {{ onProgress?: (pct:number, label:string) => void }} [opts]
 */
export async function loadWorldAssets(manager, opts = {}) {
  const onProgress = opts.onProgress ?? (() => {});
  onProgress(0.00, 'manifests');
  // Probe meta for every possible facet (0..5) — most installs have only
  // facet 0/1 and missing JSON resolves to null gracefully.
  const facetMetaJobs = [];
  for (let f = 0; f <= 5; f++) {
    facetMetaJobs.push(fetchJsonOptional(`${BASE}/map${f}.json`));
    facetMetaJobs.push(fetchJsonOptional(`${BASE}/statics${f}.json`));
  }
  const [hues, tiledata, landAtlas, staticAtlas, gumpAtlas, cliloc, mobilesAtlas, multis, animdata, texmapAtlas, housedata, cursorsManifest, radarcolManifest, fontsManifest, patches, assetOverrides, ...facetMetas] = await Promise.all([
    fetchJson(`${BASE}/hues.json`),
    manager.tiledata ?? fetchJson(`${BASE}/tiledata.json`),
    fetchJson(`${BASE}/land-atlas.json`),
    fetchJson(`${BASE}/static-atlas.json`),
    manager.gumpAtlas ?? fetchJsonOptional(`${BASE}/gump-atlas.json`),
    fetchJsonOptional(`${BASE}/cliloc.json`),
    loadMobileAtlasRoot(),
    fetchJsonOptional(`${BASE}/multi.json`),
    fetchJsonOptional(`${BASE}/animdata.json`),
    fetchJsonOptional(`${BASE}/texmap-atlas.json`),
    fetchJsonOptional(`${BASE}/housedata.json`),
    manager.cursorsManifest ?? fetchJsonOptional(`${BASE}/cursors.json`),
    fetchJsonOptional(`${BASE}/radarcol.json`),
    fetchJsonOptional(`${BASE}/fonts.json`),
    // Audit #44 P3 #20 — Verdata-style patch manifest. Mirrors what
    // ClassicUO does with verdata.mul: per-shard remaps for Gump.mul /
    // Art.mul / Hue.mul without forcing a full atlas rebuild. We use a
    // JSON manifest instead of the binary container — easier to author
    // server-side, easier to debug. Empty-or-missing → no patches.
    fetchJsonOptional(`${BASE}/patches.json`),
    fetchJsonOptional(`${BASE}/asset-overrides.json`),
    ...facetMetaJobs,
  ]);
  // Audit rev.4 P2 — additional optional manifests loaded best-effort.
  // verdata.json is the raw native UO patch container (binary blobs by
  // fileId); we expose it for power-users / future binary patching, but
  // for runtime id-remaps we still prefer the higher-level patches.json
  // schema above. professions.json + speeches.json are CUO ProfessionLoader
  // and SpeechesLoader counterparts.
  const [verdata, professions, speeches, lights, multimapMeta, unifontIndex] = await Promise.all([
    fetchJsonOptional(`${BASE}/verdata.json`),
    manager.professions ?? fetchJsonOptional(`${BASE}/professions.json`),
    fetchJsonOptional(`${BASE}/speeches.json`),
    fetchJsonOptional(`${BASE}/lights.json`),
    // Audit rev.9 P2 — Multimap.rle decoded to a grayscale PNG +
    // tiny {w,h,max} JSON. Loaded lazily on first WorldMap open by
    // a separate Image() so the multimap landing is cached but
    // doesn't block the asset-init wait.
    fetchJsonOptional(`${BASE}/multimap.json`),
    // Audit rev.9 P2 — unifont*.mul index manifest (per-font glyph
    // bank list). The per-font glyph buffers + atlas PNGs are
    // lazy-loaded on demand via `assets.loadUnifont(N)` from
    // chat-manager / world-text path when speech language matches.
    fetchJsonOptional(`${BASE}/unifont.json`),
  ]);
  manager.verdata = verdata ?? null;
  manager.professions = professions ?? null;
  manager.speeches = speeches ?? null;
  manager.lights = lights ?? null;
  manager.multimapMeta = multimapMeta ?? null;
  manager.unifontIndex = unifontIndex ?? null;
  // Cache of decoded unifont banks { [index]: { atlas: Image, lineHeight,
  // glyphs: Map<code, {x,y,w,h,ox,oy}> } } populated lazily.
  manager.unifontBanks = new Map();
  onProgress(0.20, 'manifests loaded');
  manager.huesMeta = hues;
  manager.tiledata = tiledata;
  manager.landAtlas = landAtlas;
  manager.staticAtlas = staticAtlas;
  manager.gumpAtlas = gumpAtlas;
  manager.cliloc = cliloc?.entries ?? null;
  // Client audit #4 H3 — emit cliloc:ready so tooltip / popup-menu
  // panels can invalidate any `#NNNN` placeholders cached before the
  // file landed. The first 0xC1 burst at LoginComplete previously
  // showed numeric ids until manual re-hover.
  if (manager.cliloc) {
    try { bus?.emit?.('cliloc:ready'); } catch { /* ignore */ }
  }
  // Multi-language probe: if the user prefers a non-English locale,
  // try to overlay a localized cliloc.<LANG>.json on top of ENU.
  // Falls through silently when the file isn't shipped — most
  // shards run English-only.
  try {
    const lang = (typeof globalThis.navigator !== 'undefined' &&
                  globalThis.navigator.language?.slice(0, 2).toLowerCase()) || 'en';
    if (lang !== 'en' && manager.cliloc) {
      const local = await fetchJsonOptional(`${BASE}/cliloc.${lang}.json`);
      if (local?.entries) {
        // Merge — local overrides; missing keys fall back to English.
        for (const [num, txt] of Object.entries(local.entries)) {
          manager.cliloc[num] = txt;
        }
        console.log(`[assets] cliloc.${lang}.json overlay applied (${Object.keys(local.entries).length} entries)`);
      }
    }
  } catch { /* localized overlay missing — silent fallback to ENU */ }
  manager.configureMobileAtlas?.(mobilesAtlas);
  manager.multis = multis ?? { count: 0, multis: {} };
  manager.multis.multis ??= {};
  manager.multis.count = Object.keys(manager.multis.multis).length;
  manager.animdata = animdata;
  manager.texmapAtlas = texmapAtlas;
  manager.housedata = housedata;
  manager._missingLandTextures.clear();
  manager._missingStaticTextures.clear();
  manager._missingGumpTextures.clear();
  manager._missingTexmapTextures.clear();
  manager.clearMissingAssetStats();
  // Cursor sprite manifest (extracted by `packages/extractor/cursors.js`).
  // We additionally lazy-load the atlas PNG into an HTMLImageElement so
  // canvas-2D consumers (target-cursor.js, drag-cursor.js) can blit a
  // named cursor without going through the Pixi atlas pipeline.
  manager._cursorCanvasCache.clear();
  manager.cursorsManifest = cursorsManifest;
  if (cursorsManifest && !manager.cursorsImage) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try { bus?.emit?.('cursors:ready'); } catch { /* ignore */ }
    };
    img.src = `${BASE}/${cursorsManifest.atlas ?? 'cursors-atlas.png'}`;
    manager.cursorsImage = img;          // ready when img.complete becomes true
  }
  // Radarcol — 65 536 ARGB1555 entries. Used by minimap-gump and
  // worldmap-gump for accurate per-tile colours. Convert to RGB at
  // load time so per-frame minimap blits don't re-decode each pixel.
  manager.radarcol = null;
  if (radarcolManifest?.land) {
    const toRgb = (c) => {
      if (!c) return 0;
      const r5 = (c >> 10) & 0x1f, g5 = (c >> 5) & 0x1f, b5 = c & 0x1f;
      return ((r5 << 3) | (r5 >> 2)) << 16 | ((g5 << 3) | (g5 >> 2)) << 8 | ((b5 << 3) | (b5 >> 2));
    };
    manager.radarcol = {
      land: radarcolManifest.land.map(toRgb),
      statics: radarcolManifest.static?.map(toRgb) ?? [],
    };
  }
  // UO bitmap fonts (fonts.mul → fonts.png + fonts.json). 10 ASCII
  // fonts × 224 glyphs each, packed into a single atlas. Consumed
  // by `ui/controls/uo-bitmap-text.js` so labels match the classic
  // UO look instead of the JavaScript Consolas fallback.
  manager.fonts = fontsManifest;
  // Apply any verdata-style remaps fetched from /assets/patches.json.
  // No-op when the file is missing (404 → null → falls through).
  if (patches) {
    try {
      manager.applyPatches(patches);
      const nG = manager._patches.gumps.size, nS = manager._patches.statics.size;
      if (nG || nS) {
        console.log(`[assets] patches.json applied: ${nG} gump remap${nG === 1 ? '' : 's'}, ${nS} static remap${nS === 1 ? '' : 's'}`);
      }
    } catch (e) {
      console.warn('[assets] patches.json malformed, ignoring:', e?.message);
    }
  }
  if (assetOverrides) {
    try { manager.applyAssetOverrides(assetOverrides); }
    catch (e) { console.warn('[assets] asset-overrides.json malformed, ignoring:', e?.message); }
  }
  // Audit #46 P2 — wire VerData binary applier. Was: `manager.verdata`
  // was fetched + stored but never read. Now: feeds the texture-
  // invalidation hooks so shard-side verdata.mul patches actually
  // affect the next render.
  if (manager.verdata) {
    try { manager.applyVerdataPatches(manager.verdata); }
    catch (e) { console.warn('[assets] verdata.json apply failed:', e?.message); }
  }
  if (fontsManifest) {
    manager.fontsTexturePromise = (async () => {
      try {
        const tex = await Assets.load(`${BASE}/fonts.png`);
        if (tex?.source) tex.source.scaleMode = 'nearest';
        manager.fontsTexture = tex;
      } catch (e) {
        console.warn('[assets] fonts.png load failed:', e.message);
      }
    })();
  }
  // Audit rev.9 P2 — multimap.png is a 2560×2048 grayscale world
  // overview the WorldMap gump composites as a backdrop. We lazy-load
  // it on first WorldMap open (see `loadMultimapImage`) so the asset
  // boot stays slim. The metadata JSON is already cached here.
  manager._multimapImage = null;
  manager._multimapBase = BASE;
  // Stash per-facet meta. Even facets without bins may have meta JSON; we
  // still register them so `setFacet` knows the dimensions.
  for (let f = 0; f <= 5; f++) {
    const mm = facetMetas[f * 2];
    const sm = facetMetas[f * 2 + 1];
    if (mm || sm) {
      manager._facets[f] = {
        mapMeta: mm, staticsMeta: sm,
        mapData: null, staidx: null, staticsData: null,
        staticCache: new Map(),
        mapBlockCache: new Map(), mapBlockLoads: new Map(), mapBlockPending: new Map(),
        staticLoads: new Map(), staticPending: new Map(),
        mapRangeReady: false, staticsRangeReady: false,
      };
    }
  }
  // Pick the lowest-numbered facet that has *any* data as the default.
  const haveAny = Object.keys(manager._facets).map(Number).sort((a, b) => a - b);
  const requestedFacet = Number.isInteger(opts.facet) ? opts.facet | 0 : null;
  const initialFacet = requestedFacet != null && haveAny.includes(requestedFacet)
    ? requestedFacet
    : (haveAny[0] ?? 0);
  // Preserve legacy aliases so callers (tile-renderer, walkability,
  // pathfinder) keep referring to mapMeta/staticsMeta directly.
  const slot = manager._facets[initialFacet];
  manager.mapMeta = slot?.mapMeta ?? null;
  manager.staticsMeta = slot?.staticsMeta ?? null;
  manager.currentFacet = initialFacet;

  // Hues palette texture (32 wide × N×8 tall RGBA).
  if (hues) {
    manager.huesTexture = await Assets.load(`${BASE}/hues.png`);
    // OPT WIN#1 (2026-05-07): publish to the shared hue-filter cache so
    // every applyHueTo() call uses the cached singleton-per-hue filters.
    setSharedHueLut(manager.huesTexture, manager.huesMeta?.count ?? 0);
  }
  onProgress(0.30, 'hues palette');

  // Eagerly load the binary terrain & statics for the *initial* facet
  // only. Other facets stream in via `setFacet(n)` when the player
  // crosses a moongate / teleporter / 0xBF MapChange. On a slow link
  // loading all 5 facets up-front would push first-paint past 30 s; we
  // amortise it across map changes instead.
  if (manager._facets[initialFacet]) {
    const slot = await manager._loadFacetBins(initialFacet, (pct, label) => {
      onProgress(0.30 + 0.30 * pct, label);
    });
    // Sync the legacy `_mapData/_staidx/_staticsData/_staticCache` aliases
    // so `_facetSlot(undefined)` resolves to the loaded slot. Without
    // this, init() loads bins INTO `_facets[initialFacet]` but the
    // aliases stay null — every `fetchBlock()` call then returns null and
    // chunks populate with zero sprites (visible as a blank ocean-blue
    // viewport even though `manager.visuals.size` reports 200+ chunks).
    // setFacet() does this same wiring on facet swap; init() forgot to.
    if (slot) {
      manager._mapData     = slot.mapData;
      manager._staidx      = slot.staidx;
      manager._staticsData = slot.staticsData;
      manager._staticCache = slot.staticCache;
    }
  }
  onProgress(0.60, 'facet bins ready');

  // Pre-load atlas pages through a small idle queue so the first time a chunk
  // calls `landTexture(id)` / `staticTexture(id)` the await is
  // instant without creating a large decode burst on the main thread.
  // Without this, each tile's first lookup awaited a fresh
  // `Assets.load()`, which serialised chunk population and produced
  // visible placeholder squares for several seconds.
  /** @type {{ kind:string, page:number }[]} */
  const preloadJobs = [];
  const addPreload = (kind, page) => {
    if (Number.isFinite(page)) preloadJobs.push({ kind, page: page | 0 });
  };
  // Walk each manifest's `tiles` map and collect the *actual* pages
  // referenced by any tile. The land atlas extractor advertises
  // `pageCount = ceil(0x4000 / tilesPerPage) = 8` but only writes
  // pages that contain at least one non-empty tile — sequential
  // preload via pageCount tries to fetch the gaps and produces noisy
  // 404s. Iterating the tile map is precise and forward-compatible.
  const usedPages = (atlas) => {
    const set = new Set();
    if (atlas?.tiles) {
      for (const k in atlas.tiles) set.add(atlas.tiles[k].page);
    }
    return set;
  };
  for (const p of usedPages(landAtlas))    addPreload('land', p);
  // A generated static atlas currently has 135 × 2048² pages. Preloading
  // every page transfers ~60 MB but expands beyond 2 GB in RGBA GPU memory,
  // stalls login, and immediately fights the LRU. Pages are already loaded
  // concurrently on demand by ChunkVisual.populate(), so only warm the first
  // low-id pages here (the packer preserves graphic-id order).
  const eagerStaticPages = [...usedPages(staticAtlas)]
    .sort((a, b) => a - b)
    .slice(0, ATLAS_BOOT_STATIC_PAGE_LIMIT);
  for (const p of eagerStaticPages) addPreload('static', p);
  for (const p of usedPages(texmapAtlas))  addPreload('texmap', p);
  if (mobilesAtlas?.pageCount) {
    // Mobile atlas pages are huge (~7 MB / page × 59 pages = ~420 MB)
    // and the original code preloaded the lot synchronously, blocking
    // login on cold caches. Fetch only the pages that hold the player
    // body + the most common humans/horses up-front. The remaining
    // pages stream in lazily when `mobileFrameTexture()` requests
    // a body whose page hasn't been mounted yet (asset-manager already
    // lazily resolves; we just stop preloading every page).
    const eagerPages = new Set();
    const eagerBodies = EAGER_MOBILE_BODIES;
    // The index itself intentionally has no `bodies`. Warm only a few small
    // metadata shards needed for login-area humans and mounts before choosing
    // their atlas pages. This replaces the former ~53 MB blocking manifest.
    await manager.prefetchMobileBodies?.(eagerBodies);
    const activeMobileAtlas = manager.mobilesAtlas ?? mobilesAtlas;
    const bodies = activeMobileAtlas?.bodies ?? activeMobileAtlas?.frames ?? null;
    if (bodies) {
      eagerBodyScan: for (const id of eagerBodies) {
        const body = bodies[id] ?? bodies[String(id)];
        if (!body) continue;
        // Each body is { actions: { [action]: { dirs: { [dir]: { frames: [{ page, ... }] } } } } }
        for (const act of Object.values(body.actions ?? body)) {
          for (const dir of Object.values(act?.dirs ?? act ?? {})) {
            const frames = Array.isArray(dir) ? dir : (dir?.frames ?? []);
            for (const fr of frames) {
              if (typeof fr?.page === 'number') eagerPages.add(fr.page);
              if (eagerPages.size >= ATLAS_BOOT_MOBILE_PAGE_LIMIT) break eagerBodyScan;
            }
          }
        }
      }
    }
    // A 4096² mobile page expands to ~64 MB RGBA on the GPU. A body's
    // frames are height-packed across many pages, so preloading every page
    // touched by common bodies can otherwise select 59/63 pages (>3.5 GB).
    const selectedMobilePages = [...eagerPages]
      .slice(0, ATLAS_BOOT_MOBILE_PAGE_LIMIT);
    // Fallback: at least the first pages so something animates immediately
    // even if the manifest shape doesn't match.
    if (eagerPages.size === 0) {
      selectedMobilePages.push(0);
      if (activeMobileAtlas.pageCount > 1) selectedMobilePages.push(1);
    }
    for (const p of selectedMobilePages) addPreload('mobiles', p);
  }
  // Per-page progress: increment as each page settles. Splash bar
  // shows real granular progress instead of jumping straight from
  // 60 % to 100 % when Promise.allSettled finishes.
  // Fold the UO bitmap-fonts texture into the boot wait so labels
  // built immediately after `ready` (e.g. login scene captions) pick
  // up the atlas path and don't fall back to Pixi Consolas.
  const total = preloadJobs.length + (manager.fontsTexturePromise ? 1 : 0);
  let done = 0;
  const markDone = () => {
    done++;
    onProgress(0.65 + (0.35 * done / Math.max(1, total)), `atlas pages ${done}/${total}`);
  };
  onProgress(0.65, `atlas pages 0/${total}`);
  const waits = [
    manager._runAtlasPreloadQueue(preloadJobs, ATLAS_BOOT_PRELOAD_CONCURRENCY, markDone),
  ];
  if (manager.fontsTexturePromise) waits.push(manager.fontsTexturePromise.finally(markDone));
  await Promise.allSettled(waits);
  onProgress(1.0, 'ready');
}
