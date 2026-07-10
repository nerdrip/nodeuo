// Client-side asset orchestrator. Mirrors ClassicUO.Assets/UOFileManager.cs
// at MVP scope: it knows where the static atlases live (under /assets/),
// fetches them on startup, and resolves runtime queries:
//
//   - palette lookup    (hues.png + hues.json)        → for hue shader
//   - tiledata flags    (tiledata.json)               → walk/blocking/etc
//   - land sprite       (land-atlas-NN.png + manifest)→ Pixi Texture per id
//   - static sprite     (static-atlas-NN.png  + ...)  → Pixi Texture per id
//   - gump sprite       (gump-atlas-NNN.png   + ...)  → Pixi Texture per id (when present)
//   - map block         (map0.bin via Range request)  → 196B per (cx, cy)
//   - statics block     (staidx0/statics0.bin)        → list of static items per block
//
// Loaded lazily — calling `init()` only fetches the small JSON manifests
// + hues palette. Atlas pages and map blocks are pulled on demand.

import 'pixi.js/ktx2';
import { Assets, Texture, Rectangle, setKTXTranscoderPath } from 'pixi.js';
import { bus } from '../core/event-bus.js';
import { setSharedHueLut } from '../renderer/hue-filter.js';

const BASE = '/assets';
setKTXTranscoderPath({
  jsUrl: `${BASE}/ktx/libktx.js`,
  wasmUrl: `${BASE}/ktx/libktx.wasm`,
});
const BLOCK_BYTES = 196; // 4-byte header + 64×3 LandTile
const MOBILE_FRAME_CACHE_MAX = 8192;
const MOBILE_FRAME_CACHE_TRIM = 256;
const EQUIP_ANIM_CACHE_MAX = 8192;
const EQUIP_ANIM_CACHE_TRIM = 512;
const ATLAS_BOOT_PRELOAD_CONCURRENCY = 4;
const ATLAS_PRELOAD_MAX_PER_IDLE = 2;
const ATLAS_BOOT_STATIC_PAGE_LIMIT = 2;
const ATLAS_BOOT_MOBILE_PAGE_LIMIT = 2;
const MOBILE_CYCLE_PREFETCH_CONCURRENCY = 2;
const ATLAS_PAGE_CACHE_MAX = 96;
const ATLAS_PAGE_CACHE_TRIM = 8;
const OVERLAY_KEY_FACET = 0x100000000;
const OVERLAY_KEY_AXIS = 0x10000;

function mobileFrameCacheKey(body, action, direction, frame) {
  return ((body & 0xfffff) * 0x1000000)
       + ((action & 0xff) << 16)
       + ((direction & 0xff) << 8)
       + (frame & 0xff);
}

function equipAnimCacheKey(bodyType, itemId, fallbackHue) {
  return ((bodyType & 0xffff) * 0x100000000)
       + ((itemId & 0xffff) * 0x10000)
       + (fallbackHue & 0xffff);
}

function packedFacetXY(facet, x, y) {
  return ((facet & 0xff) * OVERLAY_KEY_FACET)
       + ((y & 0xffff) * OVERLAY_KEY_AXIS)
       + (x & 0xffff);
}

function unpackFacetXY(key) {
  const facet = Math.floor(key / OVERLAY_KEY_FACET) & 0xff;
  const rem = key - facet * OVERLAY_KEY_FACET;
  return {
    facet,
    x: rem & 0xffff,
    y: Math.floor(rem / OVERLAY_KEY_AXIS) & 0xffff,
  };
}

function waitForAssetIdle(timeout = 24) {
  if (typeof globalThis.requestIdleCallback === 'function') {
    return new Promise((resolve) => {
      globalThis.requestIdleCallback(resolve, { timeout });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- Body fallback table -------------------------------------------------
// Safety substitutions for stale/incomplete generated atlases. The v2
// extractor reads AnimationFrame*.uop + AnimationSequence.uop, but a user can
// still run with an older atlas or a slim UO install missing those archives.
// In that case render a visually-similar substitute instead of a tiny stub.
//
// The substitute should be the closest stylistic match available in
// anim.mul (no UOP needed). Verified by hand against the live atlas —
// all targets here resolve to >= 32×32 frames.
const BODY_FALLBACK = Object.freeze({
  // Stygian Abyss / Mondain post-AOS bodies (Bodyconv anim4/anim5 entries).
  716: 28,    // Chicken Lizard          → Giant Spider (closest "small skittery thing")
  717: 28,    // Clockwork Scorpion      → Giant Spider
  718: 13,    // Faerie Dragon           → Air Elemental (small ethereal)
  719: 26,    // Dragon Wolf             → White Wolf
  720: 15,    // Lava Elemental          → Fire Elemental
  721: 9,     // Flayer                  → Daemon
  722: 24,    // Undead Gargoyle         → Wraith
  723: 28,    // Goblin                  → Giant Spider (humanoid not in MUL)
  724: 28,    // Gremlin                 → Giant Spider
  725: 9,     // Homunculus              → Daemon
  726: 226,   // Kepetch                 → Llama
  727: 226,   // Kepetch Shorn           → Llama
  728: 65,    // Medusa                  → Lich (snake-haired humanoid)
  729: 28,    // Mimic                   → Giant Spider
  730: 235,   // Raptor                  → Hart
  732: 51,    // RotWorm                 → Giant Serpent
  733: 5,     // Skree                   → Eagle
  734: 28,    // Slith                   → Giant Spider
  735: 28,    // Female Spider           → Giant Spider
  736: 28,    // Male Spider             → Giant Spider
  737: 28,    // Trapdoor Spider         → Giant Spider
  738: 87,    // (Trapdoor)              → fallback
  739: 26,    // Leather Wolf            → White Wolf
  740: 24,    // Shadow Dweller          → Wraith
  741: 9,     // Slasher of Veils        → Daemon
  742: 9,     // Tunnel Spirit Body      → Daemon
  743: 9,     // Tunnel Spirit Tentacle  → Daemon
  826: 12,    // Stygian Dragon          → Dragon
  829: 14,    // Rising Colossus         → Earth Elemental
  830: 24,    // Primeval Lich           → Wraith
  831: 6,     // Parrot Bird             → Bird
  832: 6,     // Phoenix                 → Bird
  // Animal range with stub frames in this client's anim.mul (cat/rabbit/rat
  // etc. live in AnimationFrame UOPs in newer mul sets).
  201: 226,   // Cat                     → Llama
  205: 226,   // Rabbit                  → Llama
  238: 226,   // Rat                     → Llama
  234: 235,   // Great Hart              → Hart variant
  235: 235,   // Hart                    → self (already best)
  287: 51,    // Blood Worm              → Giant Serpent
  // EP1 (Mondain's Legacy) — anim5 redirects, mostly UOP.
  256: 9, 257: 235, 258: 65, 259: 9, 260: 9, 261: 13,
  262: 9, 263: 9, 264: 65, 265: 12, 266: 235, 267: 9,
  269: 5,  270: 9, 271: 9, 272: 9, 273: 9,
  276: 235, 280: 9, 281: 9, 285: 14,
  277: 26,  278: 226, 279: 226, 282: 6, 283: 6, 284: 226,
  // ---- Necromancy / Bushido / Spellweaving polymorph forms.
  // The spell sets player.body to one of these; CUO's anim resolver
  // routes them to the canonical creature anim. Without explicit
  // entries the resolver falls into HIGH_GROUP and idle plays the
  // wrong frame. Mirrors ServUO `TransformContext` body table.
  747: 24,    // Lich Form          → Wraith / Lich anim
  748: 0x0303, // Wraith Form       → ghost (already canonical body)
  749: 305,   // Horrific Beast     → Beast (305 = Reaper-class)
  750: 47,    // Reaper Form        → Reaper (real body 47)
  751: 312,   // Vampiric Embrace   → Vampire Bat (312)
  752: 87,    // Lich Form alt      → 87 (Lich variant)
  753: 24,    // Necro polymorph    → Wraith
  // Bushido / Animal Form (Ninjitsu)
  754: 226,   // Animal Form llama
  755: 6,     // Animal Form bird
  756: 24,    // Animal Form rat → Wraith fallback
  // Character creation / race-change parity. Some extracted mobile
  // atlases ship the female gargoyle body (0x29B) but not male 0x29A;
  // render a visible gargoyle silhouette instead of dropping the mobile.
  666: 667,
});
// Last-resort generic by body range (used when no specific fallback +
// the original lookup returned nothing).
const GENERIC_MONSTER = 9;     // Daemon — universal "scary thing"
const GENERIC_ANIMAL  = 226;   // Llama — universal "small thing"

class AssetManager {
  constructor() {
    /** @type {{count:number,width:number,height:number,hues:any[]} | null} */
    this.huesMeta = null;
    /** @type {Texture | null} */
    this.huesTexture = null;
    /** @type {{landCount:number, staticCount:number, land:any[], statics:any[]} | null} */
    this.tiledata = null;
    /** @type {{count:number,pageCount:number,tileW:number,tileH:number,tilesPerRow:number,tiles:Record<number, any>} | null} */
    this.landAtlas = null;
    /** @type {{pageCount:number,atlasW:number,atlasH:number,tiles:Record<number, any>} | null} */
    this.staticAtlas = null;
    /** @type {{pageCount:number,atlasW:number,atlasH:number,tiles:Record<number, any>} | null} */
    this.gumpAtlas = null;
    /** @type {{pageCount:number,atlasW:number,atlasH:number,tiles:Record<number, any>} | null} */
    this.mobilesAtlas = null;
    /** @type {{pageCount:number,atlasW:number,atlasH:number,tiles:Record<number, any>} | null} */
    this.texmapAtlas = null;
    /** @type {{count:number, multis:Record<number, {id:number,x:number,y:number,z:number,visible:boolean}[]>} | null} */
    this.multis = null;
    /** @type {{count:number, entries:Record<number, {start:number,count:number,interval:number,frames:number[]}>} | null} */
    this.animdata = null;
    /** Multi-facet support — one entry per facet (0=Felucca .. 5=TerMur).
     *  Each entry holds the loaded binaries + meta JSON. Loaded lazily:
     *  the *current* facet is fetched in init(); others materialise on the
     *  first `setFacet(n)` call. Missing facets stay null silently.
     *  @type {Record<number, { mapMeta:any, staticsMeta:any, mapData:DataView|null, staidx:Uint8Array|null, staticsData:DataView|null, staticCache:Map<number,any[]> } | null>} */
    this._facets = Object.create(null);
    /** Currently-selected facet (matches `world.player.map`). */
    this.currentFacet = 0;
    /** Backwards-compat aliases — point at the *current* facet's data so
     *  existing callers (`assets.mapMeta`, `assets.fetchBlock(cx,cy)`) work
     *  unchanged. Updated by `setFacet()`. */
    this.mapMeta = null;
    this.staticsMeta = null;
    /** @type {Record<number, string> | null} cliloc id → text */
    this.cliloc = null;

    // Texture caches with a soft cap. Pixi reference-counts atlas pages,
    // but unbounded sub-region Textures still hold per-frame metadata; we
    // evict oldest when the cap is hit. Caps chosen empirically — 99% of
    // sessions stay below them.
    this._landTextures   = new Map(); // up to 4096
    this._staticTextures = new Map(); // up to 4096
    this._gumpTextures   = new Map(); // up to 2048
    this._mobileTextures = new Map(); // up to 8192 (packed body/action/dir/frame keys)
    this._texmapTextures = new Map(); // up to 1024
    this._equipAnimCache = new Map(); // packed bodyType/itemId/fallbackHue -> { animBody, hue }
    this.mobileFrameStats = {
      calls: 0, hits: 0, misses: 0, pageMisses: 0, created: 0,
      sampled: 0, totalSampleMs: 0, lastSampleMs: 0, maxSampleMs: 0,
      buckets: new Uint32Array(5),
    };
    this.assetPreloadStats = {
      jobs: 0, completed: 0, batches: 0, maxBatchSize: 0,
      concurrency: 0, maxPerIdle: 0,
    };
    this._landTextureLoads = new Map();
    this._staticTextureLoads = new Map();
    this._gumpTextureLoads = new Map();
    this._texmapTextureLoads = new Map();
    this._missingLandTextures = new Set();
    this._missingStaticTextures = new Set();
    this._missingGumpTextures = new Set();
    this._missingTexmapTextures = new Set();
    this._missingAssetCounts = new Map();
    this._cursorCanvasCache = new Map(); // cursorName|scale → processed canvas
    /** @type {Map<string, Texture>} atlas page textures by 'land:N' / 'static:N' / 'gump:N' */
    this._atlasPages = new Map();
    /** @type {Map<string, Promise<Texture | null>>} */
    this._atlasPageLoads = new Map();
    /** @type {Map<string, Promise<void>>} in-flight unloads by atlas page key */
    this._atlasPageUnloads = new Map();
    /** @type {Map<string, number>} number of sub-textures ever created from a page */
    this._atlasPageUseCounts = new Map();
    /** Verdata-style remap tables. Populated by `applyPatches()` once
     *  init() pulls /assets/patches.json. Maps SOURCE id → REPLACEMENT id;
     *  consulted at the top of every texture lookup so a single JSON
     *  manifest can rebrand custom shard art without rebuilding atlases.
     *  Per-id `hueOverride` mappings are kept on a sibling Map. */
    this._patches = {
      gumps:   new Map(),    // gumpId → alt-gumpId
      statics: new Map(),    // itemId → alt-itemId
      hues:    new Map(),    // hueIdx → { rgb } user overlay (future use)
    };

    /** Backwards-compat aliases — point at the *current* facet's slabs.
     *  Updated by `setFacet()`. New callers should go through facet methods. */
    this._staidx = null;
    this._mapData = null;
    this._staticsData = null;
    this._staticCache = new Map();
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
  async init(opts = {}) {
    const onProgress = opts.onProgress ?? (() => {});
    onProgress(0.00, 'manifests');
    // Probe meta for every possible facet (0..5) — most installs have only
    // facet 0/1 and missing JSON resolves to null gracefully.
    const facetMetaJobs = [];
    for (let f = 0; f <= 5; f++) {
      facetMetaJobs.push(fetchJsonOptional(`${BASE}/map${f}.json`));
      facetMetaJobs.push(fetchJsonOptional(`${BASE}/statics${f}.json`));
    }
    const [hues, tiledata, landAtlas, staticAtlas, gumpAtlas, cliloc, mobilesAtlas, multis, animdata, texmapAtlas, housedata, cursorsManifest, radarcolManifest, fontsManifest, patches, ...facetMetas] = await Promise.all([
      fetchJson(`${BASE}/hues.json`),
      fetchJson(`${BASE}/tiledata.json`),
      fetchJson(`${BASE}/land-atlas.json`),
      fetchJson(`${BASE}/static-atlas.json`),
      fetchJsonOptional(`${BASE}/gump-atlas.json`),
      fetchJsonOptional(`${BASE}/cliloc.json`),
      fetchJsonOptional(`${BASE}/mobiles-atlas.json`),
      fetchJsonOptional(`${BASE}/multi.json`),
      fetchJsonOptional(`${BASE}/animdata.json`),
      fetchJsonOptional(`${BASE}/texmap-atlas.json`),
      fetchJsonOptional(`${BASE}/housedata.json`),
      fetchJsonOptional(`${BASE}/cursors.json`),
      fetchJsonOptional(`${BASE}/radarcol.json`),
      fetchJsonOptional(`${BASE}/fonts.json`),
      // Audit #44 P3 #20 — Verdata-style patch manifest. Mirrors what
      // ClassicUO does with verdata.mul: per-shard remaps for Gump.mul /
      // Art.mul / Hue.mul without forcing a full atlas rebuild. We use a
      // JSON manifest instead of the binary container — easier to author
      // server-side, easier to debug. Empty-or-missing → no patches.
      fetchJsonOptional(`${BASE}/patches.json`),
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
      fetchJsonOptional(`${BASE}/professions.json`),
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
    this.verdata = verdata ?? null;
    this.professions = professions ?? null;
    this.speeches = speeches ?? null;
    this.lights = lights ?? null;
    this.multimapMeta = multimapMeta ?? null;
    this.unifontIndex = unifontIndex ?? null;
    // Cache of decoded unifont banks { [index]: { atlas: Image, lineHeight,
    // glyphs: Map<code, {x,y,w,h,ox,oy}> } } populated lazily.
    this.unifontBanks = new Map();
    onProgress(0.20, 'manifests loaded');
    this.huesMeta = hues;
    this.tiledata = tiledata;
    this.landAtlas = landAtlas;
    this.staticAtlas = staticAtlas;
    this.gumpAtlas = gumpAtlas;
    this.cliloc = cliloc?.entries ?? null;
    // Client audit #4 H3 — emit cliloc:ready so tooltip / popup-menu
    // panels can invalidate any `#NNNN` placeholders cached before the
    // file landed. The first 0xC1 burst at LoginComplete previously
    // showed numeric ids until manual re-hover.
    if (this.cliloc) {
      try { bus?.emit?.('cliloc:ready'); } catch { /* ignore */ }
    }
    // Multi-language probe: if the user prefers a non-English locale,
    // try to overlay a localized cliloc.<LANG>.json on top of ENU.
    // Falls through silently when the file isn't shipped — most
    // shards run English-only.
    try {
      const lang = (typeof globalThis.navigator !== 'undefined' &&
                    globalThis.navigator.language?.slice(0, 2).toLowerCase()) || 'en';
      if (lang !== 'en' && this.cliloc) {
        const local = await fetchJsonOptional(`${BASE}/cliloc.${lang}.json`);
        if (local?.entries) {
          // Merge — local overrides; missing keys fall back to English.
          for (const [num, txt] of Object.entries(local.entries)) {
            this.cliloc[num] = txt;
          }
          console.log(`[assets] cliloc.${lang}.json overlay applied (${Object.keys(local.entries).length} entries)`);
        }
      }
    } catch { /* localized overlay missing — silent fallback to ENU */ }
    this.mobilesAtlas = mobilesAtlas;
    this.multis = multis;
    this.animdata = animdata;
    this.texmapAtlas = texmapAtlas;
    this.housedata = housedata;
    this._missingLandTextures.clear();
    this._missingStaticTextures.clear();
    this._missingGumpTextures.clear();
    this._missingTexmapTextures.clear();
    this.clearMissingAssetStats();
    // Cursor sprite manifest (extracted by `packages/extractor/cursors.js`).
    // We additionally lazy-load the atlas PNG into an HTMLImageElement so
    // canvas-2D consumers (target-cursor.js, drag-cursor.js) can blit a
    // named cursor without going through the Pixi atlas pipeline.
    this._cursorCanvasCache.clear();
    this.cursorsManifest = cursorsManifest;
    if (cursorsManifest) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        try { bus?.emit?.('cursors:ready'); } catch { /* ignore */ }
      };
      img.src = `${BASE}/${cursorsManifest.atlas ?? 'cursors-atlas.png'}`;
      this.cursorsImage = img;          // ready when img.complete becomes true
    }
    // Radarcol — 65 536 ARGB1555 entries. Used by minimap-gump and
    // worldmap-gump for accurate per-tile colours. Convert to RGB at
    // load time so per-frame minimap blits don't re-decode each pixel.
    this.radarcol = null;
    if (radarcolManifest?.land) {
      const toRgb = (c) => {
        if (!c) return 0;
        const r5 = (c >> 10) & 0x1f, g5 = (c >> 5) & 0x1f, b5 = c & 0x1f;
        return ((r5 << 3) | (r5 >> 2)) << 16 | ((g5 << 3) | (g5 >> 2)) << 8 | ((b5 << 3) | (b5 >> 2));
      };
      this.radarcol = {
        land: radarcolManifest.land.map(toRgb),
        statics: radarcolManifest.static?.map(toRgb) ?? [],
      };
    }
    // UO bitmap fonts (fonts.mul → fonts.png + fonts.json). 10 ASCII
    // fonts × 224 glyphs each, packed into a single atlas. Consumed
    // by `ui/controls/uo-bitmap-text.js` so labels match the classic
    // UO look instead of the JavaScript Consolas fallback.
    this.fonts = fontsManifest;
    // Apply any verdata-style remaps fetched from /assets/patches.json.
    // No-op when the file is missing (404 → null → falls through).
    if (patches) {
      try {
        this.applyPatches(patches);
        const nG = this._patches.gumps.size, nS = this._patches.statics.size;
        if (nG || nS) {
          console.log(`[assets] patches.json applied: ${nG} gump remap${nG === 1 ? '' : 's'}, ${nS} static remap${nS === 1 ? '' : 's'}`);
        }
      } catch (e) {
        console.warn('[assets] patches.json malformed, ignoring:', e?.message);
      }
    }
    // Audit #46 P2 — wire VerData binary applier. Was: `this.verdata`
    // was fetched + stored but never read. Now: feeds the texture-
    // invalidation hooks so shard-side verdata.mul patches actually
    // affect the next render.
    if (this.verdata) {
      try { this.applyVerdataPatches(this.verdata); }
      catch (e) { console.warn('[assets] verdata.json apply failed:', e?.message); }
    }
    if (fontsManifest) {
      this.fontsTexturePromise = (async () => {
        try {
          const tex = await Assets.load(`${BASE}/fonts.png`);
          if (tex?.source) tex.source.scaleMode = 'nearest';
          this.fontsTexture = tex;
        } catch (e) {
          console.warn('[assets] fonts.png load failed:', e.message);
        }
      })();
    }
    // Audit rev.9 P2 — multimap.png is a 2560×2048 grayscale world
    // overview the WorldMap gump composites as a backdrop. We lazy-load
    // it on first WorldMap open (see `loadMultimapImage`) so the asset
    // boot stays slim. The metadata JSON is already cached here.
    this._multimapImage = null;
    this._multimapBase = BASE;
    // Stash per-facet meta. Even facets without bins may have meta JSON; we
    // still register them so `setFacet` knows the dimensions.
    for (let f = 0; f <= 5; f++) {
      const mm = facetMetas[f * 2];
      const sm = facetMetas[f * 2 + 1];
      if (mm || sm) {
        this._facets[f] = {
          mapMeta: mm, staticsMeta: sm,
          mapData: null, staidx: null, staticsData: null,
          staticCache: new Map(),
        };
      }
    }
    // Pick the lowest-numbered facet that has *any* data as the default.
    const haveAny = Object.keys(this._facets).map(Number).sort((a, b) => a - b);
    const initialFacet = haveAny[0] ?? 0;
    // Preserve legacy aliases so callers (tile-renderer, walkability,
    // pathfinder) keep referring to mapMeta/staticsMeta directly.
    const slot = this._facets[initialFacet];
    this.mapMeta = slot?.mapMeta ?? null;
    this.staticsMeta = slot?.staticsMeta ?? null;
    this.currentFacet = initialFacet;

    // Hues palette texture (32 wide × N×8 tall RGBA).
    if (hues) {
      this.huesTexture = await Assets.load(`${BASE}/hues.png`);
      // OPT WIN#1 (2026-05-07): publish to the shared hue-filter cache so
      // every applyHueTo() call uses the cached singleton-per-hue filters.
      setSharedHueLut(this.huesTexture, this.huesMeta?.count ?? 0);
    }
    onProgress(0.30, 'hues palette');

    // Eagerly load the binary terrain & statics for the *initial* facet
    // only. Other facets stream in via `setFacet(n)` when the player
    // crosses a moongate / teleporter / 0xBF MapChange. On a slow link
    // loading all 5 facets up-front would push first-paint past 30 s; we
    // amortise it across map changes instead.
    if (this._facets[initialFacet]) {
      const slot = await this._loadFacetBins(initialFacet, (pct, label) => {
        onProgress(0.30 + 0.30 * pct, label);
      });
      // Sync the legacy `_mapData/_staidx/_staticsData/_staticCache` aliases
      // so `_facetSlot(undefined)` resolves to the loaded slot. Without
      // this, init() loads bins INTO `_facets[initialFacet]` but the
      // aliases stay null — every `fetchBlock()` call then returns null and
      // chunks populate with zero sprites (visible as a blank ocean-blue
      // viewport even though `this.visuals.size` reports 200+ chunks).
      // setFacet() does this same wiring on facet swap; init() forgot to.
      if (slot) {
        this._mapData     = slot.mapData;
        this._staidx      = slot.staidx;
        this._staticsData = slot.staticsData;
        this._staticCache = slot.staticCache;
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
      const eagerBodies = [
        0x0190, 0x0191, 0x0192, 0x0193,                 // human m/f first
        0x000C, 0x000D,
        0x00C8, 0x00E2, 0x00E4, 0x00CC, 0x0035,         // horses + warhorse
      ];
      const bodies = mobilesAtlas?.bodies ?? mobilesAtlas?.frames ?? null;
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
        if (mobilesAtlas.pageCount > 1) selectedMobilePages.push(1);
      }
      for (const p of selectedMobilePages) addPreload('mobiles', p);
    }
    // Per-page progress: increment as each page settles. Splash bar
    // shows real granular progress instead of jumping straight from
    // 60 % to 100 % when Promise.allSettled finishes.
    // Fold the UO bitmap-fonts texture into the boot wait so labels
    // built immediately after `ready` (e.g. login scene captions) pick
    // up the atlas path and don't fall back to Pixi Consolas.
    const total = preloadJobs.length + (this.fontsTexturePromise ? 1 : 0);
    let done = 0;
    const markDone = () => {
      done++;
      onProgress(0.65 + (0.35 * done / Math.max(1, total)), `atlas pages ${done}/${total}`);
    };
    onProgress(0.65, `atlas pages 0/${total}`);
    const waits = [
      this._runAtlasPreloadQueue(preloadJobs, ATLAS_BOOT_PRELOAD_CONCURRENCY, markDone),
    ];
    if (this.fontsTexturePromise) waits.push(this.fontsTexturePromise.finally(markDone));
    await Promise.allSettled(waits);
    onProgress(1.0, 'ready');
  }

  /** Resolve a multi id (house/boat/etc.) to its tile list, or null. */
  multiTiles(multiId) {
    return this.multis?.multis?.[multiId] ?? null;
  }

  /** Reverse-lookup: graphic id → house component role. Mirrors what
   *  CUO `HouseCustomizationManager.SeekGraphicInCustomHouseObjectListWithCategory`
   *  does — given any wall/door/floor/stair/roof/misc/teleporter graphic
   *  the player can place via the housing system, return its role label.
   *
   *  Used by tile-renderer (roof-cut-off confirmation), doors.js (auto-
   *  detect door pieces without a hand-curated list), and house-manager
   *  (bounds inference). Built lazily on first call.
   *
   *  Returns one of: 'wall', 'door', 'floor', 'stair', 'roof', 'misc',
   *  'teleporter', or `null` when the graphic isn't in any housedata
   *  table. */
  houseRole(graphicId) {
    if (!this.housedata) return null;
    if (!this._houseRoleMap) this._buildHouseRoleMap();
    return this._houseRoleMap.get(graphicId | 0) ?? null;
  }

  /** Door piece lookup. Housedata stores 8 CLOSED facings/hinges for
   *  each door style. Runtime open art is `closedId + 1`, so callers
   *  should use this to identify the closed style/piece, not as an
   *  open/closed flag. Returns `{ category, pieceIdx }` or null.
   *
   *  Mirrors CUO's `HouseCustomizationManager.Doors` array iteration
   *  used by `BaseDoor.OnClick`. Replaces our hand-curated 17-entry
   *  table in apps/scripts/src/items/doors.js. */
  doorPiece(graphicId) {
    if (!this.housedata?.doors) return null;
    if (!this._doorPieceMap) this._buildDoorPieceMap();
    return this._doorPieceMap.get(graphicId | 0) ?? null;
  }

  /** Suppinfo lookup — returns the per-graphic adjacency / support entry
   *  from `suppinfo.txt` (1900 entries). Used by walkability to confirm
   *  whether a tile can support a standing mobile (`directSupports !== 0`).
   *
   *  Returns `{ top, bottom, directSupports, cangoW, cangoN, cangoNWC,
   *  adjUN, adjLN, adjUE, adjLE, adjUS, adjLS, adjUW, adjLW }` or null. */
  suppInfo(graphicId) {
    if (!this.housedata?.suppinfo) return null;
    if (!this._suppInfoMap) this._buildSuppInfoMap();
    return this._suppInfoMap.get(graphicId | 0) ?? null;
  }

  _buildSuppInfoMap() {
    /** @type {Map<number, any>} */
    const map = new Map();
    for (const e of this.housedata?.suppinfo ?? []) {
      if (Number.isFinite(e?.tileNumber)) map.set(e.tileNumber | 0, e);
    }
    this._suppInfoMap = map;
  }

  /** Get the 8 CLOSED pieces for a door category id. */
  doorCategoryPieces(category) {
    return this.housedata?.doors?.find?.((c) => c.category === category)?.styles?.[0]?.pieces ?? null;
  }

  _buildHouseRoleMap() {
    /** @type {Map<number, string>} */
    const map = new Map();
    const add = (role, list) => {
      if (!Array.isArray(list)) return;
      for (const cat of list) {
        for (const style of cat.styles ?? []) {
          for (const piece of style.pieces ?? []) {
            if (piece > 0 && !map.has(piece)) map.set(piece, role);
          }
        }
      }
    };
    add('wall',       this.housedata?.walls);
    add('door',       this.housedata?.doors);
    add('floor',      this.housedata?.floors);
    add('stair',      this.housedata?.stairs);
    add('roof',       this.housedata?.roofs);
    add('misc',       this.housedata?.misc);
    add('teleporter', this.housedata?.teleprts);
    this._houseRoleMap = map;
  }

  _buildDoorPieceMap() {
    /** @type {Map<number, {category:number, pieceIdx:number}>} */
    const map = new Map();
    for (const cat of this.housedata?.doors ?? []) {
      for (const style of cat.styles ?? []) {
        const pieces = style.pieces ?? [];
        for (let i = 0; i < pieces.length; i++) {
          const g = pieces[i] | 0;
          if (g > 0 && !map.has(g)) map.set(g, { category: cat.category, pieceIdx: i });
        }
      }
    }
    this._doorPieceMap = map;
  }

  /** Compute the *current* animated graphic for a static id. Mirrors
   *  CUO AnimDataLoader.CalculateCurrentGraphic(). Returns the original
   *  id if the tile is not in the animation table.
   *
   *  DEFENSIVE clamps:
   *    - Real UO animations cycle through ≤8 contiguous art slots —
   *      anything beyond ±32 is corrupt extractor output (animdata.mul
   *      pads each entry with 64 frame bytes regardless of the actual
   *      `count`, so a poorly-cleaned dump leaves junk -127/+109 at
   *      the tail). User report: water barrel cycling into banners.
   *    - When `count` looks suspicious (==64 with a long zero prefix),
   *      trim to the leading non-zero run so the modulo doesn't pull
   *      from the trailing garbage. */
  currentAnimatedGraphic(graphicId, nowMs) {
    const e = this.animdata?.entries?.[graphicId];
    if (!e || e.count <= 0) return graphicId;
    let count = e.count | 0;
    const frames = e.frames;
    if (count >= 60) {
      // Find the actual animation length by walking from index 0 to
      // the first run of consecutive zeros that lasts to the end.
      let last = 0;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i] !== 0) last = i + 1;
      }
      // Cap at 16 — any legitimate UO anim cycle is ≤ 8 frames.
      count = Math.min(16, Math.max(1, last));
    }
    // CUO `Game/Managers/AnimatedStaticsManager.cs:67,91-93`:
    //   `delay = ITEM_EFFECT_ANIMATION_DELAY (50) * 2 = 100 ms`
    //   `next  = delay * FrameInterval`
    // We used to multiply by 50 → animated flames / candles / moongates
    // looped twice as fast as on real UO. Per-frame factor is 100 ms.
    const intervalMs = Math.max(50, e.interval * 100);
    const frame = Math.floor(nowMs / intervalMs) % count;
    const off = frames[frame] | 0;
    // Clamp wild offsets — anything past ±32 is data corruption.
    const safeOff = (off > 32 || off < -32) ? 0 : off;
    return graphicId + safeOff;
  }

  // ---------------------------------------------------------------------
    // Cursors — paint a named cursor sprite onto a 2D canvas.

  /** Resolve a cursor entry by name (e.g. `'walk-n'`, `'target-neutral'`,
   *  `'default'`). Returns `{ x, y, w, h, hotspotX, hotspotY }` or null. */
  cursorMeta(name) {
    return this.cursorsManifest?.cursors?.[name] ?? null;
  }

  /** Paint a named cursor sprite into a cached canvas. Returns
   *  the canvas (callers can append to a DOM div for follow-mouse use)
   *  or null if the manifest / atlas isn't loaded yet.
   *
   *  Bigger than the source by `scale` (default 1) — cursor sprites
   *  are tiny (16×16 to 32×32) and look pixelated at native size on
   *  high-DPI screens. `scale = 2` gives a comfortable size without
   *  losing UO's pixel-art feel.
   */
  paintCursor(name, scale = 2) {
    const cacheKey = `${name}|${scale}`;
    const cached = this._cursorCanvasCache.get(cacheKey);
    if (cached) return cached;
    const meta = this.cursorMeta(name);
    if (!meta || !this.cursorsImage) return null;
    if (!this.cursorsImage.complete || this.cursorsImage.naturalWidth === 0) {
      // Atlas image still loading — caller should retry next frame.
      return null;
    }
    // Two-step paint:
    //   1. Blit the source slice 1:1 into a small scratch canvas so we
    //      can post-process pixel data (drop UO's blue "shadow" pixels
    //      that bleed around several cursor sprites).
    //   2. Upsample to the final size with imageSmoothingEnabled=false
    //      so the pixel-art stays crisp.
    const scratch = document.createElement('canvas');
    scratch.width = meta.w; scratch.height = meta.h;
    const sctx = scratch.getContext('2d');
    if (!sctx) return null;
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(this.cursorsImage, meta.x, meta.y, meta.w, meta.h, 0, 0, meta.w, meta.h);
    try {
      const img = sctx.getImageData(0, 0, meta.w, meta.h);
      const px = img.data;
      // UO art uses a dark-blue / dark-purple shadow band around many
      // cursor sprites. Marcin: "bez niebieskich obwódek". Drop any
      // pixel where blue dominates by a wide margin AND overall
      // brightness is low — that's the shadow halo, not real cursor
      // colour. We only touch pixels that aren't already transparent.
      // Plus green decorative dots on walk-cursors (Marcin: "te zielone
      // kropki mnie irytują") — strip pixels where green dominates by
      // a wide margin AND red/blue are low. Same threshold logic.
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        // Strong blue + dark = halo. Threshold tuned conservatively so
        // legitimate blue ink (target-self crystal) survives.
        if (b > 60 && r < 40 && g < 40 && (b - r) > 30 && (b - g) > 30) {
          px[i + 3] = 0;
          continue;
        }
        // Strong green-only = decorative direction dot on walk-cursors.
        // target-beneficial sprite has lighter green ink so we gate
        // on r/b being low to avoid clipping that.
        if (g > 80 && r < 40 && b < 40 && (g - r) > 40 && (g - b) > 40) {
          px[i + 3] = 0;
        }
      }
      sctx.putImageData(img, 0, 0);
    } catch { /* CORS-tainted canvas; skip the post-process */ }
    const w = meta.w * scale;
    const h = meta.h * scale;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, meta.w, meta.h, 0, 0, w, h);
    this._cursorCanvasCache.set(cacheKey, canvas);
    return canvas;
  }

  // ---------------------------------------------------------------------
  // Cliloc — numbered string lookup with `~N_arg~` interpolation.

  /**
   * Resolve a cliloc id to text. Optional `args` is the tab-delimited
   * argument list ServUO sends in 0xC1 / 0xCC; placeholders look like
   * `~1_THING~` / `~2_VERB~` and are replaced positionally. Falls back
   * to the literal `#NNNN` placeholder when the entry is missing.
   *
   * @param {number} id
   * @param {string} [args]
   */
  cl(id, args = '') {
    const text = this.cliloc?.[id];
    if (!text) return `#${id}`;
    if (!args) return text;
    const parts = args.split('\t');
    return text.replace(/~(\d+)_[^~]*~/g, (_m, n) => {
      const i = parseInt(n, 10) - 1;
      return parts[i] ?? '';
    });
  }

  // ---------------------------------------------------------------------
  // Land / static / gump → Pixi Texture

  /** Cap a cache map by evicting the oldest key once `max` is reached.
   *  Map insertion preserves insertion order, so the first key is the LRU. */
  _capCache(map, max) {
    if (map.size <= max) return;
    while (map.size > max) {
      const k = map.keys().next().value;
      const t = map.get(k);
      const texture = t?.texture ?? t;
      const pageKey = texture?._uoAtlasPageKey;
      try { texture?.destroy?.(false); } catch { /* ignore */ }
      if (pageKey) {
        const refs = Math.max(0, (this._atlasPageUseCounts.get(pageKey) || 0) - 1);
        if (refs === 0) this._atlasPageUseCounts.delete(pageKey);
        else this._atlasPageUseCounts.set(pageKey, refs);
      }
      map.delete(k);
    }
  }

  /** Move a cache hit to the back of the Map so `_capCache` evicts the
   *  least recently used sub-texture instead of whichever id was inserted
   *  first during login/chunk bootstrap. */
  _touchCache(map, key, value) {
    if (!value || !map.has(key)) return value;
    map.delete(key);
    map.set(key, value);
    this._touchAtlasPageForCached(value);
    return value;
  }

  _atlasPageKey(kind, pageIndex) {
    return `${kind}:${pageIndex | 0}`;
  }

  _touchAtlasPageKey(key) {
    const tex = this._atlasPages.get(key);
    if (!tex) return null;
    this._atlasPages.delete(key);
    this._atlasPages.set(key, tex);
    return tex;
  }

  _getAtlasPageSync(kind, pageIndex) {
    return this._touchAtlasPageKey(this._atlasPageKey(kind, pageIndex));
  }

  _registerSubTexture(tex, pageKey) {
    if (!tex || !pageKey) return tex;
    tex._uoAtlasPageKey = pageKey;
    this._atlasPageUseCounts.set(pageKey, (this._atlasPageUseCounts.get(pageKey) || 0) + 1);
    this._touchAtlasPageKey(pageKey);
    return tex;
  }

  _touchAtlasPageForCached(value) {
    const tex = value?.texture ?? value;
    const key = tex?._uoAtlasPageKey;
    if (key) this._touchAtlasPageKey(key);
  }

  _capAtlasPages(max = ATLAS_PAGE_CACHE_MAX) {
    if (this._atlasPages.size <= max) return;
    const target = Math.max(0, max - ATLAS_PAGE_CACHE_TRIM);
    for (const [key, tex] of this._atlasPages) {
      if (this._atlasPages.size <= target) break;
      if ((this._atlasPageUseCounts.get(key) || 0) > 0) continue;
      if (this._atlasPageLoads.has(key) || this._atlasPageUnloads.has(key)) continue;
      this._atlasPages.delete(key);
      const url = tex?._uoAtlasPageUrl;
      if (url) {
        const unload = Assets.unload(url)
          .catch((e) => {
            console.warn(`[assets] atlas page unload failed ${key}`, e?.message ?? e);
          })
          .finally(() => {
            this._atlasPageUnloads.delete(key);
          });
        this._atlasPageUnloads.set(key, unload);
      } else {
        try { tex?.destroy?.(true); } catch { /* ignore */ }
      }
    }
  }

  get atlasPageStats() {
    let used = 0;
    for (const key of this._atlasPages.keys()) {
      if ((this._atlasPageUseCounts.get(key) || 0) > 0) used++;
    }
    return {
      pages: this._atlasPages.size,
      used,
      unused: this._atlasPages.size - used,
      unloading: this._atlasPageUnloads.size,
      limit: ATLAS_PAGE_CACHE_MAX,
    };
  }

  _noteMissingTexture(kind, id, set) {
    const numericId = id | 0;
    if (set.has(numericId)) return;
    set.add(numericId);
    const key = `${kind}:${numericId}`;
    const prev = this._missingAssetCounts.get(key);
    this._missingAssetCounts.set(key, {
      kind,
      id: numericId,
      count: (prev?.count ?? 0) + 1,
    });
  }

  get missingAssetStats() {
    const top = [...this._missingAssetCounts.values()]
      .sort((a, b) => (b.count - a.count) || a.kind.localeCompare(b.kind) || (a.id - b.id));
    const byKind = Object.create(null);
    for (const entry of top) byKind[entry.kind] = (byKind[entry.kind] | 0) + 1;
    return {
      total: top.length,
      byKind,
      top: top.slice(0, 16).map((entry) => ({ ...entry })),
    };
  }

  clearMissingAssetStats() {
    this._missingAssetCounts.clear();
  }

  /** Get a Pixi Texture for a land tile id. Returns null if not in atlas. */
  async landTexture(id) {
    id = id | 0;
    let tex = this._landTextures.get(id);
    if (tex) return this._touchCache(this._landTextures, id, tex);
    if (this._missingLandTextures.has(id)) return null;
    const pending = this._landTextureLoads.get(id);
    if (pending) return pending;
    const meta = this.landAtlas?.tiles[id];
    if (!meta) {
      this._noteMissingTexture('land', id, this._missingLandTextures);
      return null;
    }
    const load = (async () => {
      const page = await this._loadAtlasPage('land', meta.page);
      if (!page) return null;
      const cached = this._landTextures.get(id);
      if (cached) return this._touchCache(this._landTextures, id, cached);
      tex = new Texture({
        source: page.source,
        frame: new Rectangle(meta.u, meta.v, this.landAtlas.tileW, this.landAtlas.tileH),
      });
      this._registerSubTexture(tex, page._uoAtlasPageKey);
      this._landTextures.set(id, tex);
      this._capCache(this._landTextures, 4096);
      return tex;
    })();
    this._landTextureLoads.set(id, load);
    try {
      return await load;
    } finally {
      if (this._landTextureLoads.get(id) === load) this._landTextureLoads.delete(id);
    }
  }

  /** Synchronous land-art resolver for chunk mount hot paths. Returns
   *  null when the atlas page is not resident yet; callers can then fall
   *  back to async `landTexture()`. */
  landTextureSync(id) {
    id = id | 0;
    let tex = this._landTextures.get(id);
    if (tex) return this._touchCache(this._landTextures, id, tex);
    if (this._missingLandTextures.has(id)) return null;
    const meta = this.landAtlas?.tiles[id];
    if (!meta) {
      this._noteMissingTexture('land', id, this._missingLandTextures);
      return null;
    }
    const page = this._getAtlasPageSync('land', meta.page);
    if (!page) return null;
    tex = new Texture({
      source: page.source,
      frame: new Rectangle(meta.u, meta.v, this.landAtlas.tileW, this.landAtlas.tileH),
    });
    this._registerSubTexture(tex, page._uoAtlasPageKey);
    this._landTextures.set(id, tex);
    this._capCache(this._landTextures, 4096);
    return tex;
  }

  /** Apply a verdata-style patch manifest. Shape:
   *    { gumps: { "0x08AC": 0x08B0 }, statics: { ... }, hues: { ... } }
   *  Numeric keys parsed via Number() so both `"0x08AC"` and `2220`
   *  shapes work. Patches are additive — calling again merges. */
  applyPatches(patches) {
    if (!patches || typeof patches !== 'object') return;
    const parseId = (k) => {
      if (typeof k === 'number') return k | 0;
      const s = String(k).trim();
      if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16) | 0;
      return parseInt(s, 10) | 0;
    };
    const mergeIdMap = (target, src) => {
      if (!src) return;
      for (const [k, v] of Object.entries(src)) {
        target.set(parseId(k), parseId(v));
      }
    };
    mergeIdMap(this._patches.gumps,   patches.gumps);
    mergeIdMap(this._patches.statics, patches.statics);
    if (patches.hues && typeof patches.hues === 'object') {
      for (const [k, v] of Object.entries(patches.hues)) {
        this._patches.hues.set(parseId(k), v);   // raw rgb override blob
      }
    }
    // Drop any already-resolved textures whose source ids were just
    // remapped — otherwise the cached texture wins on the next lookup
    // and the patch never takes effect.
    if (patches.gumps) {
      for (const k of Object.keys(patches.gumps)) {
        const id = parseId(k);
        this._gumpTextures.delete(id);
        this._gumpTextureLoads.delete(id);
        this._missingGumpTextures.delete(id);
      }
    }
    if (patches.statics) {
      for (const k of Object.keys(patches.statics)) {
        const id = parseId(k);
        this._staticTextures.delete(id);
        this._staticTextureLoads.delete(id);
        this._missingStaticTextures.delete(id);
      }
    }
  }

  /** Audit #46 P2 — VerData applier. CUO `VerdataLoader.cs` reads each
   *  `{ fileId, blockId, data }` entry: fileId 0x04 = art (gump/static),
   *  fileId 0x07 = gump.mul, fileId 0x14 = hue. Our extractor (`packages/
   *  extractor/verdata.js`) writes the raw entries; this applier walks
   *  them and either remaps the resource id (when the patch shape is
   *  `{id: replacementId}`) or stores the raw blob for later texture
   *  uploads. For our atlas-driven pipeline the simplest route is to
   *  treat each entry as a remap stub so the existing `applyPatches`
   *  invalidation hooks fire. Shards that ship binary verdata typically
   *  also ship the pre-extracted atlas; this hook is the safety net. */
  /**
   * Audit rev.9 P2 — load the multimap.png world-overview backdrop
   * lazily on first WorldMap open. Returns a `HTMLImageElement` that's
   * cached for subsequent calls. Returns `null` when the file isn't
   * shipped (extractor skipped or shard slim install).
   */
  loadMultimapImage() {
    if (this._multimapImage) return this._multimapImage;
    if (!this.multimapMeta) return null;
    const img = new Image();
    img.src = `${this._multimapBase}/multimap.png`;
    img.decoding = 'async';
    this._multimapImage = img;
    return img;
  }
  /**
   * Audit rev.9 P2 — load a single unifont bank (atlas PNG + glyph
   * record buffer) on demand. The records buffer is base64 in JSON, we
   * decode it into a `Map<code, {x,y,w,h,ox,oy}>` for O(1) glyph lookup.
   * Used by chat-manager / world-text when a UnicodeSpeech (0xAE) packet
   * arrives with a language code that needs a non-Latin glyph bank.
   */
  async loadUnifont(index) {
    if (!this.unifontIndex?.fonts) return null;
    if (this.unifontBanks.has(index)) return this.unifontBanks.get(index);
    const meta = this.unifontIndex.fonts.find((f) => f.index === index);
    if (!meta) return null;
    const BASE = this._multimapBase;
    let perFont;
    try {
      const res = await fetch(`${BASE}/${meta.manifest}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      perFont = await res.json();
    } catch (e) {
      console.warn(`[assets] unifont-${index}.json load failed:`, e?.message);
      return null;
    }
    // Decode base64 → Uint8Array → Map<code, glyph>.
    const glyphs = new Map();
    const recordsBin = (() => {
      try {
        const bin = atob(perFont.records ?? '');
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
      } catch { return new Uint8Array(0); }
    })();
    const view = new DataView(recordsBin.buffer);
    const count = perFont.glyphCount | 0;
    for (let k = 0; k < count; k++) {
      const off = k * 12;
      if (off + 12 > recordsBin.length) break;
      const code = view.getUint16(off, true);
      const x = view.getUint16(off + 2, true);
      const y = view.getUint16(off + 4, true);
      const w = view.getUint8(off + 6);
      const h = view.getUint8(off + 7);
      const ox = view.getInt8(off + 8);
      const oy = view.getInt8(off + 9);
      glyphs.set(code, { x, y, w, h, ox, oy });
    }
    const atlas = new Image();
    atlas.src = `${BASE}/${perFont.file}`;
    atlas.decoding = 'async';
    const bank = {
      atlas, atlasW: perFont.atlasW, atlasH: perFont.atlasH,
      lineHeight: perFont.lineHeight | 0,
      glyphs,
    };
    this.unifontBanks.set(index, bank);
    return bank;
  }
  applyVerdataPatches(verdata) {
    if (!verdata?.entries?.length) return;
    let nGumps = 0, nStatics = 0, nHues = 0;
    for (const e of verdata.entries) {
      const fileId = e.fileId | 0;
      const blockId = e.blockId | 0;
      if (fileId === 0x04 /* art / statics */) {
        // No replacement id encoded — flush the cached texture so the
        // next load picks up the patched payload from the extracted
        // atlas (which the extractor should have rebuilt with verdata
        // applied). Defensive: skip if the cache key is absent.
        this._staticTextures.delete(blockId);
        this._staticTextureLoads.delete(blockId);
        this._missingStaticTextures.delete(blockId);
        nStatics++;
      } else if (fileId === 0x07 /* gump */) {
        this._gumpTextures.delete(blockId);
        this._gumpTextureLoads.delete(blockId);
        this._missingGumpTextures.delete(blockId);
        nGumps++;
      } else if (fileId === 0x14 /* hue */) {
        // Hues are tiny (88 B per entry); we store the raw blob keyed
        // by index so hue lookups can override the base palette.
        this._patches.hues.set(blockId, e.data);
        nHues++;
      }
    }
    if (nGumps || nStatics || nHues) {
      console.log(`[assets] verdata.json applied: ${nGumps} gump + ${nStatics} static + ${nHues} hue overrides`);
    }
  }

  async staticTexture(id) {
    // Verdata-style remap. Patch table is empty for unpatched shards so
    // this Map.get() is O(1) and essentially free.
    const remapped = this._patches?.statics?.get(id | 0);
    if (remapped != null) id = remapped;
    id = id | 0;
    let tex = this._staticTextures.get(id);
    if (tex) return this._touchCache(this._staticTextures, id, tex);
    if (this._missingStaticTextures.has(id)) return null;
    const pending = this._staticTextureLoads.get(id);
    if (pending) return pending;
    // statics0.mul / multi.mul / network packets all use LOCAL art ids
    // (0..0xBFFF). The art.mul atlas was extracted with GLOBAL art ids
    // (LAND_COUNT + local = 0x4000..0xFFFF). Look up by both — local
    // first, then global as a fallback.
    const tiles = this.staticAtlas?.tiles;
    const meta = tiles?.[id] ?? tiles?.[id + 0x4000];
    if (!meta) {
      this._noteMissingTexture('static', id, this._missingStaticTextures);
      return null;
    }
    const load = (async () => {
      const page = await this._loadAtlasPage('static', meta.page);
      if (!page) return null;
      const cached = this._staticTextures.get(id);
      if (cached) return this._touchCache(this._staticTextures, id, cached);
      tex = new Texture({
        source: page.source,
        frame: new Rectangle(meta.u, meta.v, meta.w, meta.h),
      });
      tex._uoAtlasPageUrl = page._uoAtlasPageUrl;
      tex._uoAtlasPageKind = page._uoAtlasPageKind;
      tex._uoAtlasPageKey = page._uoAtlasPageKey;
      this._registerSubTexture(tex, page._uoAtlasPageKey);
      this._staticTextures.set(id, tex);
      this._capCache(this._staticTextures, 4096);
      return tex;
    })();
    this._staticTextureLoads.set(id, load);
    try {
      return await load;
    } finally {
      if (this._staticTextureLoads.get(id) === load) this._staticTextureLoads.delete(id);
    }
  }

  /** Synchronous static-art resolver for render hot paths. Returns null
   *  when the atlas page is not loaded yet; callers can then schedule the
   *  async `staticTexture()` path without allocating a Promise every
   *  animation frame. */
  staticTextureSync(id) {
    const remapped = this._patches?.statics?.get(id | 0);
    if (remapped != null) id = remapped;
    id = id | 0;
    let tex = this._staticTextures.get(id);
    if (tex) return this._touchCache(this._staticTextures, id, tex);
    if (this._missingStaticTextures.has(id)) return null;
    const tiles = this.staticAtlas?.tiles;
    const meta = tiles?.[id] ?? tiles?.[id + 0x4000];
    if (!meta) {
      this._noteMissingTexture('static', id, this._missingStaticTextures);
      return null;
    }
    const page = this._getAtlasPageSync('static', meta.page);
    if (!page) return null;
    tex = new Texture({
      source: page.source,
      frame: new Rectangle(meta.u, meta.v, meta.w, meta.h),
    });
    this._registerSubTexture(tex, page._uoAtlasPageKey);
    this._staticTextures.set(id, tex);
    this._capCache(this._staticTextures, 4096);
    return tex;
  }

  /** Resolve a stretched-land Texmap (texmaps.mul). Indexed by the
   *  texId stored on each LandTile in tiledata. Returns null if no
   *  texmap atlas exists or the id has no stretched texture (most
   *  flat decorative tiles like roads / dungeon floors). */
  async texmapTexture(texId) {
    texId = texId | 0;
    if (!this.texmapAtlas || !texId) return null;
    let tex = this._texmapTextures.get(texId);
    if (tex) return this._touchCache(this._texmapTextures, texId, tex);
    if (this._missingTexmapTextures.has(texId)) return null;
    const pending = this._texmapTextureLoads.get(texId);
    if (pending) return pending;
    const meta = this.texmapAtlas.tiles[texId];
    if (!meta) {
      this._noteMissingTexture('texmap', texId, this._missingTexmapTextures);
      return null;
    }
    const load = (async () => {
      const page = await this._loadAtlasPage('texmap', meta.page);
      if (!page) return null;
      const cached = this._texmapTextures.get(texId);
      if (cached) return this._touchCache(this._texmapTextures, texId, cached);
      tex = new Texture({
        source: page.source,
        frame: new Rectangle(meta.u, meta.v, meta.w, meta.h),
      });
      this._registerSubTexture(tex, page._uoAtlasPageKey);
      this._texmapTextures.set(texId, tex);
      this._capCache(this._texmapTextures, 1024);
      return tex;
    })();
    this._texmapTextureLoads.set(texId, load);
    try {
      return await load;
    } finally {
      if (this._texmapTextureLoads.get(texId) === load) this._texmapTextureLoads.delete(texId);
    }
  }

  /** Sync lookup for a gump's natural pixel dimensions. Returns null
   *  when the atlas isn't loaded yet or the id is missing. Used by
   *  WindowGump-derived constructors to size their chrome to the real
   *  container/paperdoll/etc. art instead of guessing at a fixed
   *  width × height. Cheap — just a dictionary read. */
  gumpSize(id) {
    if (!this.gumpAtlas) return null;
    const meta = this.gumpAtlas.tiles[id];
    if (!meta) return null;
    return { w: meta.w | 0, h: meta.h | 0 };
  }

  async gumpTexture(id) {
    if (!this.gumpAtlas) return null;
    // Verdata-style remap (see applyPatches). Allows a shard to swap
    // e.g. the spellbook chrome 0x08AC for a custom 0x08B0 without
    // rebuilding the atlas.
    const remapped = this._patches?.gumps?.get(id | 0);
    if (remapped != null) id = remapped;
    id = id | 0;
    let tex = this._gumpTextures.get(id);
    if (tex) return this._touchCache(this._gumpTextures, id, tex);
    if (this._missingGumpTextures.has(id)) return null;
    const pending = this._gumpTextureLoads.get(id);
    if (pending) return pending;
    const meta = this.gumpAtlas.tiles[id];
    if (!meta) {
      this._noteMissingTexture('gump', id, this._missingGumpTextures);
      return null;
    }
    const load = (async () => {
      const page = await this._loadAtlasPage('gump', meta.page);
      if (!page) return null;
      const cached = this._gumpTextures.get(id);
      if (cached) return this._touchCache(this._gumpTextures, id, cached);
      tex = new Texture({
        source: page.source,
        frame: new Rectangle(meta.u, meta.v, meta.w, meta.h),
      });
      tex._uoAtlasPageUrl = page._uoAtlasPageUrl;
      tex._uoAtlasPageKind = page._uoAtlasPageKind;
      tex._uoAtlasPageKey = page._uoAtlasPageKey;
      this._registerSubTexture(tex, page._uoAtlasPageKey);
      this._gumpTextures.set(id, tex);
      this._capCache(this._gumpTextures, 2048);
      return tex;
    })();
    this._gumpTextureLoads.set(id, load);
    try {
      return await load;
    } finally {
      if (this._gumpTextureLoads.get(id) === load) this._gumpTextureLoads.delete(id);
    }
  }

  /** Walk Body.def aliases + atlas manifest to find the (meta, frameCount,
   *  page-key, realBody) tuple for a given (body, action, direction, frame).
   *  Returns null if the body / action / dir is unknown. Pure lookup —
   *  doesn't touch the page cache.
   *
   *  Tiny-frame fallback: post-AOS / Stygian Abyss bodies (clockwork
   *  scorpion 717, dragon wolf 719, fire ant 738, etc.) live in the
   *  `AnimationFrame*.uop` containers which our extractor doesn't read
   *  yet. Their MUL idx slots are either stub-sized (a few hundred bytes
   *  containing "1px placeholder" frames) or empty. When the resolved
   *  frame is suspiciously small (< 16 px on a side) for a Monster /
   *  Animal body, we substitute a known-good generic body so the user
   *  sees something plausible instead of "two pixels of hair". The
   *  remap table below is hand-curated — extend it as new broken
   *  bodies surface. */
  _mobileFrameMeta(body, action, direction, frame) {
    if (!this.mobilesAtlas) return null;
    const meta = this._tryMobileFrame(body, action, direction, frame);
    if (meta && (meta.meta.w >= 16 || meta.meta.h >= 16)) return meta;
    // Fallback: pick a substitute body from BODY_FALLBACK and retry.
    const sub = BODY_FALLBACK[body | 0];
    if (sub != null) {
      const alt = this._tryMobileFrame(sub, action, direction, frame);
      if (alt) return alt;
    }
    // Last-ditch: generic "monster" body so the sprite isn't a 1×1 dot.
    if (!meta) {
      const generic = body < 200 ? GENERIC_MONSTER : (body < 400 ? GENERIC_ANIMAL : null);
      if (generic != null) {
        const alt = this._tryMobileFrame(generic, action, direction, frame);
        if (alt) return alt;
      }
    }
    return meta;
  }

  /** Bare lookup with body.def alias resolution — no fallback substitution.
   *  Action fallback chain: requested → 2 (animal/people stand) → 0 (walk)
   *  → ANY action present on this body. Necessary because UOP-extracted
   *  bodies don't follow the legacy MUL group numbering — Stygian
   *  Abyss bodies (e.g. 717 / 735 / 738) only have a handful of named
   *  actions and none of them might match the canonical "stand" group
   *  for their CUO body type. Better to render SOME pose than nothing. */
  _tryMobileFrame(body, action, direction, frame) {
    const alias = this.mobilesAtlas?.aliases?.[body];
    const realBody = alias?.body ?? alias?.trueBody ?? body;
    const b = this.mobilesAtlas?.bodies?.[realBody];
    if (!b) return null;
    const resolvedAction = this._resolveMobileActionAlias(b, action);
    let actionEntry = b.actions?.[resolvedAction];
    if (!actionEntry) actionEntry = b.actions?.['2'] ?? b.actions?.['0'];
    if (!actionEntry) {
      // Last-ditch: take whichever action this body DOES have.
      const keys = Object.keys(b.actions ?? {});
      if (keys.length === 0) return null;
      actionEntry = b.actions[keys[0]];
    }
    if (!actionEntry) return null;
    let dirFrames = actionEntry.dirs?.[direction];
    if (!dirFrames) dirFrames = actionEntry.dirs?.['0'];
    if (!dirFrames) {
      const dkeys = Object.keys(actionEntry.dirs ?? {});
      if (dkeys.length === 0) return null;
      dirFrames = actionEntry.dirs[dkeys[0]];
    }
    const meta = dirFrames[frame] ?? dirFrames[0];
    if (!meta) return null;
    return {
      realBody,
      action: actionEntry === b.actions?.[resolvedAction] ? resolvedAction : action,
      direction,
      frame,
      meta,
      frameCount: dirFrames.length,
    };
  }

  _resolveMobileActionAlias(bodyEntry, action) {
    let resolved = action | 0;
    const aliases = bodyEntry?.actionAliases;
    // A small loop also tolerates chained mappings from older generated
    // manifests while preventing malformed data from cycling forever.
    for (let i = 0; i < 4; i++) {
      const next = aliases?.[resolved];
      if (!Number.isInteger(next) || next === resolved) break;
      resolved = next;
    }
    return resolved;
  }

  _mobileBodyEntry(body) {
    if (!this.mobilesAtlas) return null;
    const alias = this.mobilesAtlas.aliases?.[body];
    const realBody = alias?.body ?? alias?.trueBody ?? body;
    const b = this.mobilesAtlas.bodies?.[realBody];
    return b ? { realBody, body: b } : null;
  }

  /** Body animation type/flags from mobtypes.txt, emitted by the extractor. */
  mobileBodyInfo(body) {
    if (!this.mobilesAtlas) return null;
    const alias = this.mobilesAtlas.aliases?.[body];
    const realBody = alias?.body ?? alias?.trueBody ?? body;
    return this.mobilesAtlas.mobTypes?.[body]
      ?? this.mobilesAtlas.mobTypes?.[realBody]
      ?? null;
  }

  /** Exact manifest probe for animation group selection. Unlike
   *  `_tryMobileFrame()`, this does not fall back to stand/walk/any-action:
   *  callers use it to pick the best CUO group remap before texture lookup.
   */
  mobileActionExists(body, action, direction = null) {
    const entry = this._mobileBodyEntry(body);
    if (!entry) return false;
    const actions = entry.body.actions ?? {};
    const actionKey = String(this._resolveMobileActionAlias(entry.body, action));
    if (!Object.prototype.hasOwnProperty.call(actions, actionKey)) return false;
    if (direction == null) return true;
    const dirs = actions[actionKey]?.dirs ?? {};
    const dirKey = String(direction | 0);
    return Object.prototype.hasOwnProperty.call(dirs, dirKey)
      || Object.prototype.hasOwnProperty.call(dirs, '0')
      || Object.keys(dirs).length > 0;
  }

  /** Synchronous variant — returns `{ texture, cx, cy, w, h, frameCount }`
   *  if the underlying atlas page is already loaded into memory, OR null
   *  when it isn't (caller should treat null as "wait + prefetch"). The
   *  cache stores fully-resolved Pixi Textures so subsequent ticks hit
   *  zero-cost. Mirrors `mobileFrameTexture` but never awaits.
   *
   *  This is the primary entry point for the per-frame renderer hot path
   *  — the async variant is kept for one-off uses (corpse render, drag
   *  preview) where blocking on the texture load is acceptable. */
  mobileFrameTextureSync(body, action, direction, frame) {
    const stats = this.mobileFrameStats;
    stats.calls = (stats.calls + 1) >>> 0;
    const t0 = ((stats.calls & 63) === 0 && typeof performance !== 'undefined')
      ? performance.now()
      : -1;
    if (!this.mobilesAtlas) {
      stats.misses++;
      this._recordMobileFrameSample(t0);
      return null;
    }
    // Run the full meta resolution (including fallbacks) so the cache
    // keys against the BODY WE ACTUALLY RENDER. Without this every
    // tick re-ran the substitution path because cache misses on the
    // alias-only key.
    const info = this._mobileFrameMeta(body, action, direction, frame);
    if (!info) {
      stats.misses++;
      this._recordMobileFrameSample(t0);
      return null;
    }
    const key = mobileFrameCacheKey(info.realBody, info.action, info.direction, info.frame);
    const cached = this._mobileTextures.get(key);
    if (cached) {
      stats.hits++;
      this._recordMobileFrameSample(t0);
      return cached;
    }
    stats.misses++;
    // Page must already be in `_atlasPages` — the sync path can't await.
    // Touch the page LRU directly; async `_loadAtlasPage()` covers misses.
    const pageKey = this._atlasPageKey('mobiles', info.meta.page);
    const page = this._getAtlasPageSync('mobiles', info.meta.page);
    if (!page) {
      stats.pageMisses++;
      this._recordMobileFrameSample(t0);
      return null;
    }
    const tex = new Texture({
      source: page.source,
      frame: new Rectangle(info.meta.u, info.meta.v, info.meta.w, info.meta.h),
    });
    this._registerSubTexture(tex, pageKey);
    const wrapped = {
      texture: tex,
      cx: info.meta.cx, cy: info.meta.cy,
      w: info.meta.w, h: info.meta.h,
      frameCount: info.frameCount,
    };
    this._mobileTextures.set(key, wrapped);
    stats.created++;
    // Hard-cap LRU drain — earlier code only evicted ONE entry per
    // insert, so a city full of unique bodies (PvP, polymorph, mount
    // variety) drove the Map past 8192 indefinitely (single-step
    // eviction can't keep up with bursts). Drain to a soft floor so
    // we don't churn on every set when sitting at the cap.
    if (this._mobileTextures.size > MOBILE_FRAME_CACHE_MAX) {
      const target = MOBILE_FRAME_CACHE_MAX - MOBILE_FRAME_CACHE_TRIM;
      while (this._mobileTextures.size > target) {
        const k = this._mobileTextures.keys().next().value;
        const v = this._mobileTextures.get(k);
        try { v?.texture?.destroy?.(false); } catch { /* ignore */ }
        this._mobileTextures.delete(k);
      }
    }
    this._recordMobileFrameSample(t0);
    return wrapped;
  }

  _recordMobileFrameSample(t0) {
    if (t0 < 0 || typeof performance === 'undefined') return;
    const dt = performance.now() - t0;
    const stats = this.mobileFrameStats;
    stats.sampled++;
    stats.totalSampleMs += dt;
    stats.lastSampleMs = dt;
    if (dt > stats.maxSampleMs) stats.maxSampleMs = dt;
    const b = stats.buckets;
    if (dt < 0.05) b[0]++;
    else if (dt < 0.15) b[1]++;
    else if (dt < 0.5) b[2]++;
    else if (dt < 1.5) b[3]++;
    else b[4]++;
  }

  /** Async preload — given a (body, action, direction), kick off page
   *  loads for EVERY frame in that cycle so the next sync lookup is a
   *  guaranteed hit. Used by mobile-renderer when the action / direction
   *  changes so the very next tick has all textures ready. Returns a
   *  promise that resolves when all frames in this cycle are cached.
   */
  async prefetchMobileCycle(body, action, direction) {
    if (!this.mobilesAtlas) return;
    const alias = this.mobilesAtlas.aliases?.[body];
    const realBody = alias?.body ?? alias?.trueBody ?? body;
    const b = this.mobilesAtlas.bodies?.[realBody];
    if (!b) return;
    const resolvedAction = this._resolveMobileActionAlias(b, action);
    const actionEntry = b.actions?.[resolvedAction] ?? b.actions?.['2'] ?? b.actions?.['0'];
    if (!actionEntry) return;
    const dirFrames = actionEntry.dirs?.[direction] ?? actionEntry.dirs?.['0'];
    if (!dirFrames) return;
    // Collect unique page indices across the whole cycle so we make at
    // most one `_loadAtlasPage` call per page (typically all frames of
    // one direction live on the same page).
    const pages = new Set();
    for (const f of dirFrames) if (f && typeof f.page === 'number') pages.add(f.page);
    await this._runAtlasPreloadQueue(
      pages,
      MOBILE_CYCLE_PREFETCH_CONCURRENCY,
      null,
      'mobiles',
    );
  }

  /** Resolve a single anim frame to a Texture. Walks Body.def aliases.
   *  Returns `{ texture, cx, cy, w, h, frameCount }` or null.
   *  Async — for renderer hot path use `mobileFrameTextureSync`. */
  async mobileFrameTexture(body, action, direction, frame) {
    const info = this._mobileFrameMeta(body, action, direction, frame);
    if (!info) return null;
    // Ensure the page is loaded, then defer to the sync path which
    // handles caching + texture construction.
    await this._loadAtlasPage('mobiles', info.meta.page);
    return this.mobileFrameTextureSync(body, action, direction, frame);
  }

  /** Convenience for the old static-frame caller: returns the body's
   *  Idle action / direction 0 / frame 0. */
  async mobileTexture(body) {
    return this.mobileFrameTexture(body, 2, 0, 0);
  }

  /** Resolve the animation body + hue to use for an equipped item on a
   *  given mob body type. Mirrors ClassicUO's Equipconv lookup with a
   *  tiledata.animId fallback (CUO `MobileAnimation.GetGraphicForAnimation`).
   *
   *  The previous fallback returned `animBody: itemId` which is wrong:
   *  the mobile-atlas is keyed by ANIMATION body (e.g. 431 for "long
   *  pants"), not by item id (0x1539). Without the animId redirect the
   *  asset manager warned `body missing in atlas {body: '0x1539'}` and
   *  every clothing layer silently dropped from the paperdoll body. */
  resolveEquipAnim(bodyType, itemId, fallbackHue = 0) {
    const key = equipAnimCacheKey(bodyType, itemId, fallbackHue);
    const cached = this._equipAnimCache.get(key);
    if (cached) return this._touchCache(this._equipAnimCache, key, cached);
    const m = this.mobilesAtlas?.equipConv?.[bodyType];
    const e = m?.[itemId];
    let resolved;
    if (e) resolved = { animBody: e.animBody, hue: e.hue || fallbackHue };
    else {
      const animId = this.tiledata?.statics?.[itemId]?.animId | 0;
      resolved = animId > 0
        ? { animBody: animId, hue: fallbackHue }
        : { animBody: itemId, hue: fallbackHue };
    }
    this._equipAnimCache.set(key, resolved);
    if (this._equipAnimCache.size > EQUIP_ANIM_CACHE_MAX) {
      const target = EQUIP_ANIM_CACHE_MAX - EQUIP_ANIM_CACHE_TRIM;
      while (this._equipAnimCache.size > target) {
        this._equipAnimCache.delete(this._equipAnimCache.keys().next().value);
      }
    }
    return resolved;
  }

  /** Map a living body → its corpse rendering body via Corpse.def. */
  resolveCorpseBody(body) {
    return this.mobilesAtlas?.corpseConv?.[body] ?? null;
  }

  async _loadAtlasPage(kind, pageIndex) {
    const key = this._atlasPageKey(kind, pageIndex);
    const tex = this._touchAtlasPageKey(key);
    if (tex) return tex;
    const unloading = this._atlasPageUnloads.get(key);
    if (unloading) {
      try { await unloading; } catch { /* best effort */ }
      const afterUnload = this._touchAtlasPageKey(key);
      if (afterUnload) return afterUnload;
    }
    const pending = this._atlasPageLoads.get(key);
    if (pending) return pending;
    const load = this._loadAtlasPageUncached(kind, pageIndex, key);
    this._atlasPageLoads.set(key, load);
    try {
      return await load;
    } finally {
      if (this._atlasPageLoads.get(key) === load) this._atlasPageLoads.delete(key);
    }
  }

  async _runAtlasPreloadQueue(jobs, concurrency = 2, onSettled = null, fixedKind = null) {
    if (!jobs) return;
    if (!jobs.length && !(jobs instanceof Set)) return;
    const list = [];
    if (jobs instanceof Set) {
      for (const page of jobs) list.push({ kind: fixedKind, page });
    } else {
      for (const job of jobs) list.push(fixedKind ? { kind: fixedKind, page: job } : job);
    }
    if (list.length === 0) return;
    const requestedConcurrency = Math.max(1, concurrency | 0 || 1);
    const maxPerIdle = Math.max(1, Math.min(
      list.length,
      requestedConcurrency,
      ATLAS_PRELOAD_MAX_PER_IDLE,
    ));
    this.assetPreloadStats = {
      jobs: list.length,
      completed: 0,
      batches: 0,
      maxBatchSize: 0,
      concurrency: requestedConcurrency,
      maxPerIdle,
    };
    for (let cursor = 0; cursor < list.length;) {
      await waitForAssetIdle();
      const batch = [];
      while (batch.length < maxPerIdle && cursor < list.length) {
        batch.push(list[cursor++]);
      }
      this.assetPreloadStats.batches++;
      if (batch.length > this.assetPreloadStats.maxBatchSize) {
        this.assetPreloadStats.maxBatchSize = batch.length;
      }
      await Promise.allSettled(batch.map(async (job) => {
        const kind = job?.kind ?? fixedKind;
        const page = job?.page;
        try {
          if (kind != null && Number.isFinite(page)) await this._loadAtlasPage(kind, page | 0);
        } catch (e) {
          console.warn(`[assets] atlas preload failed ${kind}:${page}`, e?.message ?? e);
        } finally {
          this.assetPreloadStats.completed++;
          onSettled?.();
        }
      }));
    }
  }

  async _loadAtlasPageUncached(kind, pageIndex, key) {
    let tex = null;
    // Padding widths used by each extractor (must match the file names).
    const PAD = { land: 2, static: 3, gump: 3, mobiles: 2, texmap: 2 };
    const padding = PAD[kind] ?? 2;
    const stem = `${kind}-atlas-${String(pageIndex).padStart(padding, '0')}`;
    // Prefer compressed `.ktx2` (Basis Universal) when the extractor
    // produced it — Pixi v8 ships a KTX2 loader that uploads BC7/ETC2C
    // directly to the GPU, halving VRAM and skipping the PNG-decode
    // burst on the main thread (~150 ms × 60 mobile pages on first
    // boot). PNG remains the canonical format; KTX2 is opt-in via the
    // extractor `--ktx2` flag. Standard-pipeline BasisU encoding stays
    // a P3 asset-build task, not a runtime-client gap.
    const candidates = [
      `${BASE}/${stem}.ktx2`,
      `${BASE}/${stem}.png`,
    ];
    for (const url of candidates) {
      try {
        // HEAD pre-flight: file must exist AND be the expected binary
        // type. Vite's dev server falls back to index.html (200,
        // text/html) for any path that doesn't match a file on disk —
        // we filter that out so we don't try to parse HTML as a texture.
        const head = await fetch(url, { method: 'HEAD' });
        if (!head.ok) continue;
        const ct = (head.headers.get('content-type') || '').toLowerCase();
        if (ct.startsWith('text/') || ct.includes('html')) continue;
        tex = await Assets.load(url);
        // Pixi v8 warns + returns a falsy value when no parser matches
        // (e.g. .ktx2 without the basis transcoder registered). Treat
        // that as a load failure and fall through to the next candidate.
        if (!tex || !tex.source) { tex = null; continue; }
        // Pixel-art sampling: keep edges crisp at zoom > 1.
        try { tex.source.scaleMode = 'nearest'; } catch { /* ignore */ }
        tex._uoAtlasPageKey = key;
        tex._uoAtlasPageKind = kind;
        tex._uoAtlasPageUrl = url;
        this._atlasPages.set(key, tex);
        this._capAtlasPages();
        return tex;
      } catch (e) {
        // KTX2 may be unsupported by the runtime even when the file
        // exists (older browser without WASM transcoder). Fall through
        // to the next candidate silently; the PNG fallback covers it.
        if (url.endsWith('.png')) console.warn(`[assets] missing atlas page ${url}`, e?.message);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Map blocks (8×8 land tiles per chunk) — multi-facet aware

  /** Stream the binary terrain + statics slabs for `facet` into memory.
   *  Idempotent (no-op when already cached). */
  async _loadFacetBins(facet, onProgress = () => {}) {
    const slot = this._facets[facet];
    if (!slot) return null;
    if (slot.mapData && slot.staidx && slot.staticsData) return slot;
    onProgress(0.0, `facet ${facet} loading`);
    const mapJob = slot.mapMeta && !slot.mapData
      ? fetch(`${BASE}/map${facet}.bin`).then((r) => r.arrayBuffer()).catch((e) => {
          console.warn(`[assets] map${facet}.bin load failed`, e); return null;
        })
      : Promise.resolve(null);
    const idxJob = slot.staticsMeta && !slot.staidx
      ? fetch(`${BASE}/staidx${facet}.bin`).then((r) => r.arrayBuffer()).catch((e) => {
          console.warn(`[assets] staidx${facet}.bin load failed`, e); return null;
        })
      : Promise.resolve(null);
    const datJob = slot.staticsMeta && !slot.staticsData
      ? fetch(`${BASE}/statics${facet}.bin`).then((r) => r.arrayBuffer()).catch((e) => {
          console.warn(`[assets] statics${facet}.bin load failed`, e); return null;
        })
      : Promise.resolve(null);
    const [mapAb, idxAb, datAb] = await Promise.all([mapJob, idxJob, datJob]);
    if (mapAb) slot.mapData = new DataView(mapAb);
    onProgress(0.5, `facet ${facet} terrain`);
    if (idxAb) slot.staidx = new Uint8Array(idxAb);
    if (datAb) slot.staticsData = new DataView(datAb);
    onProgress(1.0, `facet ${facet} ready`);
    return slot;
  }

  /** Switch the active facet — loads bins on demand and re-points the
   *  legacy aliases so existing callers see the new map. Callers should
   *  invalidate downstream caches (chunk visuals, mobile sectors) when
   *  this resolves; tile-renderer listens on `bus.emit('facet:changed')`. */
  async setFacet(facet) {
    facet = facet | 0;
    if (facet < 0 || facet > 5) return false;
    if (this.currentFacet === facet && this._mapData) return true;
    const slot = await this._loadFacetBins(facet);
    if (!slot) return false;
    this.currentFacet = facet;
    this.activeFacet  = facet;        // alias used by landAt overlay key
    this.mapMeta     = slot.mapMeta;
    this.staticsMeta = slot.staticsMeta;
    this._mapData    = slot.mapData;
    this._staidx     = slot.staidx;
    this._staticsData = slot.staticsData;
    this._staticCache = slot.staticCache;
    // Pull any admin Map Editor overlay edits for this facet so the
    // chunk renderer paints the live tiles instead of the disk version.
    // Cheap (sparse JSON, typically <1 KB) — fire-and-forget; missing
    // admin server (UO_ADMIN_PORT off) is tolerated silently.
    this.fetchLandOverlay(facet).catch(() => {});
    return true;
  }

  /** Resolve a {meta, mapData, staidx, staticsData, staticCache} slot for a
   *  given facet, falling back to the active facet. Used by methods that
   *  want explicit per-facet access without changing global state. */
  _facetSlot(facet) {
    if (facet == null || facet === this.currentFacet) {
      return {
        mapMeta: this.mapMeta, staticsMeta: this.staticsMeta,
        mapData: this._mapData, staidx: this._staidx,
        staticsData: this._staticsData, staticCache: this._staticCache,
      };
    }
    return this._facets[facet] ?? null;
  }

  /** Look up the LandTile at world coords. Returns { id, z } or null if
   *  map data isn't loaded yet (rare; init() awaits it).
   *
   *  Consults the live edit overlay BEFORE the on-disk mapData buffer
   *  so admin Map Editor saves take effect in-game without a relog.
   *  The overlay is populated by `applyOverlayEdits()` (called from
   *  the WS push or boot-time `fetchLandOverlay()`). */
  landAt(tx, ty, facet) {
    const slot = this._facetSlot(facet);
    if (!slot?.mapMeta || !slot.mapData) return null;
    if (this._landOverlay?.size) {
      const fkey = (facet ?? this.activeFacet ?? 0) | 0;
      const ov = this._landOverlay.get(packedFacetXY(fkey, tx, ty));
      if (ov) return { id: ov.tileId, z: ov.z };
    }
    const cx = Math.floor(tx / 8), cy = Math.floor(ty / 8);
    if (cx < 0 || cy < 0 || cx >= slot.mapMeta.blocksWide || cy >= slot.mapMeta.blocksTall) return null;
    const block = cx * slot.mapMeta.blocksTall + cy;
    const ix = (tx % 8), iy = (ty % 8);
    const off = block * BLOCK_BYTES + 4 + (iy * 8 + ix) * 3;
    const id = slot.mapData.getUint16(off, true);
    const z  = slot.mapData.getInt8(off + 2);
    return { id, z };
  }

  /** Resolve the chunk-block DataView (slice of the active facet's map.bin).
   *  Returns the RAW disk buffer — overlay edits apply only to per-tile
   *  `landAt` reads (cheaper than rewriting the buffer for every paint
   *  stroke). The renderer composes a chunk by calling `landAt` for each
   *  of the 8×8 tiles, so overlay edits land naturally during chunk
   *  re-mount. */
  async fetchBlock(cx, cy, facet) {
    const slot = this._facetSlot(facet);
    if (!slot?.mapMeta || !slot.mapData) return null;
    if (cx < 0 || cy < 0 || cx >= slot.mapMeta.blocksWide || cy >= slot.mapMeta.blocksTall) return null;
    const block = cx * slot.mapMeta.blocksTall + cy;
    const offset = block * BLOCK_BYTES;
    return new DataView(slot.mapData.buffer, slot.mapData.byteOffset + offset, BLOCK_BYTES);
  }

  /** Apply / merge overlay edits. Each edit is `{facet, x, y, tileId, z}`.
   *  Affected chunks are emitted via `bus.emit('chunk:invalidate', {cx, cy, facet})`
   *  so the tile renderer can tear them down + re-mount with new tiles. */
  applyOverlayEdits(edits) {
    if (!Array.isArray(edits) || edits.length === 0) return 0;
    if (!this._landOverlay) this._landOverlay = new Map();
    const dirtyChunks = new Set();
    for (const e of edits) {
      if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y)) continue;
      const f = (e.facet ?? 0) | 0;
      const k = packedFacetXY(f, e.x | 0, e.y | 0);
      this._landOverlay.set(k, { tileId: e.tileId | 0, z: e.z | 0 });
      const cx = Math.floor(e.x / 8), cy = Math.floor(e.y / 8);
      dirtyChunks.add(packedFacetXY(f, cx, cy));
    }
    // Client audit #4 H2 — was lazy `import('../core/event-bus.js')`
    // with a Promise.then that arrived AFTER the first burst of map
    // edits. That first call silently dropped the chunk:invalidate
    // events. Static import on top guarantees the bus is ready.
    if (bus?.emit) {
      for (const k of dirtyChunks) {
        const { facet, x: cx, y: cy } = unpackFacetXY(k);
        bus.emit('chunk:invalidate', { facet, cx, cy });
      }
    }
    return dirtyChunks.size;
  }

  /** Boot-time fetch of every overlay edit for a facet. Called after
   *  asset init so the player sees admin map paints immediately on
   *  login (without this they'd see disk tiles until manual [resync). */
  async fetchLandOverlay(facet) {
    try {
      const r = await fetch(`http://${location.hostname}:2596/api/map/overlay?facet=${facet | 0}`, {
        credentials: 'include',
      });
      if (!r.ok) return 0;
      const j = await r.json();
      return this.applyOverlayEdits(j.edits ?? []);
    } catch {
      return 0;     // admin server not reachable; ignore
    }
  }

  // ---------------------------------------------------------------------
  // Statics per block

  staticsAt(cx, cy, facet) {
    const slot = this._facetSlot(facet);
    if (!slot?.staticsMeta || !slot.staidx) return null;
    if (cx < 0 || cy < 0 || cx >= slot.staticsMeta.blocksWide || cy >= slot.staticsMeta.blocksTall) return null;
    const block = cx * slot.staticsMeta.blocksTall + cy;
    return slot.staticCache.get(block) ?? null;
  }

  async fetchStatics(cx, cy, facet) {
    const slot = this._facetSlot(facet);
    if (!slot?.staticsMeta || !slot.staidx || !slot.staticsData) return null;
    if (cx < 0 || cy < 0 || cx >= slot.staticsMeta.blocksWide || cy >= slot.staticsMeta.blocksTall) return null;
    const block = cx * slot.staticsMeta.blocksTall + cy;
    let cached = slot.staticCache.get(block);
    if (cached !== undefined) return cached;

    const offset = (slot.staidx[block * 8 + 0]      )
                 | (slot.staidx[block * 8 + 1] << 8 )
                 | (slot.staidx[block * 8 + 2] << 16)
                 | (slot.staidx[block * 8 + 3] << 24);
    const size   = (slot.staidx[block * 8 + 4]      )
                 | (slot.staidx[block * 8 + 5] << 8 )
                 | (slot.staidx[block * 8 + 6] << 16)
                 | (slot.staidx[block * 8 + 7] << 24);
    if (offset === 0xFFFFFFFF || size <= 0) {
      slot.staticCache.set(block, []);
      return [];
    }
    const dv = slot.staticsData;
    const items = [];
    for (let i = 0; i + 7 <= size; i += 7) {
      items.push({
        id:  dv.getUint16(offset + i + 0, true),
        x:   dv.getUint8(offset + i + 2),
        y:   dv.getUint8(offset + i + 3),
        z:   dv.getInt8(offset + i + 4),
        hue: dv.getUint16(offset + i + 5, true),
      });
    }
    slot.staticCache.set(block, items);
    return items;
  }
}

// OPT WIN#2 (2026-05-07): IDB-backed manifest cache. We open the database
// once and route all manifest fetches through it so a tab refresh sends
// `If-None-Match` and gets a 304 instead of re-downloading 5+ MB of JSON.
import { openIdbCache } from './idb-cache.js';
let _idbCachePromise = null;
function _idbCache() {
  if (!_idbCachePromise) _idbCachePromise = openIdbCache().catch(() => null);
  return _idbCachePromise;
}

// Manifests we route through the JSON worker — the biggest payloads
// whose parse cost would otherwise spike the main thread. Smaller
// JSON manifests stay on the IDB-cache path where the parse cost is
// negligible. Names match the trailing path component.
const HEAVY_MANIFESTS = new Set([
  'tiledata.json',     // ~3-4 MB parsed in ~80ms
  'animdata.json',     // ~1-2 MB
  'multi.json',        // ~500 KB
  'cliloc.json',       // ~2 MB
]);

async function fetchJson(url) {
  const name = url.split('/').pop() ?? url;
  // Heavy manifests bypass IDB on first run and go through the worker
  // for off-thread parsing. Subsequent loads still warm from IDB via
  // the regular path (the worker is only worth its setup cost for
  // genuinely large payloads).
  if (HEAVY_MANIFESTS.has(name)) {
    try {
      const { fetchJsonInWorker } = await import('./worker-json.js');
      const data = await fetchJsonInWorker(url);
      if (data != null) return data;
    } catch (e) {
      console.warn('[assets] worker fetch failed for', name, e?.message ?? e);
      // fall through to IDB path
    }
  }
  const c = await _idbCache();
  if (c) {
    const data = await c.getOrFetch(name, url);
    if (data == null) throw new Error(`${url} → empty`);
    return data;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
async function fetchJsonOptional(url) {
  try { return await fetchJson(url); }
  catch { return null; }
}

export const assets = new AssetManager();
