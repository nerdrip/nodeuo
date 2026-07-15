// Land + statics renderer with real UO art.
//
// Each chunk (8×8 tiles) is mounted as one Pixi Container that holds:
//   - 64 land sprites (Pixi Sprite, 44×44 from land-atlas)
//   - the chunk's static sprites (variable count per chunk)
// The container's children are sorted on (Y + Z) to match ClassicUO's
// back-to-front draw order.

import { Container, Sprite, Graphics, Text, TextStyle, Ticker } from 'pixi.js';
import { CHUNK_SIZE } from '../world/map.js';
import { TILE_W, TILE_H, TILE_HALF_W, TILE_HALF_H, Z_STEP, worldToScreenX, worldToScreenY,
         depthKey, LAYER_LAND, LAYER_STATIC, LAYER_ITEM } from './iso.js';
import { assets } from '../assets/asset-manager.js';
import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';
import { applyHueTo } from './hue-filter.js';
import { acquireLandMesh, acquireSprite, landMeshPool, releaseLandMesh, releaseSprite } from './sprite-pool.js';
import { seasonManager } from '../managers/season-manager.js';
import { profile as profileManager } from '../managers/profile-manager.js';
import { lightPoints, staticLightSpec } from './light-points.js';
import { houseCustomization } from '../managers/house-customization-manager.js';
import { landEntry, staticEntry } from '../shared/tiledata.js';
import { FLAG_WET } from '../shared/tiledata-flags.js';
import { displayItemIdForAmount } from '../shared/stack-graphics.js';
import { isAnimdataStaticGraphic } from './static-animation.js';
import { clientRuntimeProfile, FrameTaskScheduler } from '../shared/runtime-governor.js';

function releaseRenderObject(displayObject) {
  if (!displayObject) return;
  if (displayObject instanceof Sprite) releaseSprite(displayObject);
  else if (displayObject._uoLandMeshPool) releaseLandMesh(displayObject);
  else { try { displayObject.destroy(); } catch { /* ignore */ } }
}
import { MobileAnimation, Action } from './mobile-animation.js';
import { corpseManager } from '../managers/corpse-manager.js';
import { DoorTileIndex } from './door-tile-index.js';
import {
  assignTallStructureBounds, boundsContains as _boundsContains, createTallStructureScratch,
  shouldHideTallEntry, tallTileKey as _tallTileKey,
  tallStaticBounds, tallStructureBoundsForPlayer,
} from './tall-structure.js';
export { assignTallStructureBounds, shouldHideTallEntry, tallStaticBounds, tallStructureBoundsForPlayer } from './tall-structure.js';

const doorTileIndex = new DoorTileIndex({
  resolveDoorPiece: (itemId) => assets.doorPiece?.(itemId),
  chunkSize: CHUNK_SIZE,
});
const EMPTY_ARRAY = Object.freeze([]);
const STATIC_ANIM_TICK_MS = 50;
const MAX_ADD_CHILD_BATCH = 256;
const MAX_CHUNK_POPULATES = 3;
const CHUNK_REVEAL_MS = 300;
const CHUNK_REVEAL_STAGGER_MS = 18;
const CHUNK_REVEAL_TINT = 0x8FA7B5;
const FOLIAGE_STUMP_GRAPHIC = 0x0CCB;
const FIELD_GRAPHIC_MIN = 0x398C;
const FIELD_GRAPHIC_MAX = 0x399F;
const FLAG_BACKGROUND = 0x00000001;
const FLAG_TRANSPARENT = 0x00000004;
const FLAG_TRANSLUCENT = 0x00000008;
const FLAG_WALL = 0x00000010;
const FLAG_SURFACE = 0x00000200;
const FLAG_BRIDGE = 0x00000400;
const FLAG_FOLIAGE = 0x00020000;
const FLAG_ROOF = 0x10000000;
const ROOF_DEBUG_LABEL_STYLE = new TextStyle({
  fill: 0xffd36a,
  fontSize: 12,
  fontFamily: 'Consolas, monospace',
  stroke: { color: 0x000000, width: 3 },
});

// One shared ticker drives every unresolved chunk and terrain reveal. A
// listener per chunk becomes surprisingly expensive during teleports, while
// this remains one O(visible-loading) pass and detaches when streaming ends.
const activeChunkShimmers = new Set();
const activeChunkReveals = new Set();
let chunkTransitionTickerInstalled = false;

function _chunkTransitionsTick() {
  const now = performance.now();
  for (const entry of activeChunkShimmers) {
    if (!entry.gfx || entry.gfx.destroyed) {
      activeChunkShimmers.delete(entry);
      continue;
    }
    const phase = ((now - entry.startedAt) % 1050) / 1050;
    const wave = phase * entry.phases.length;
    for (let i = 0; i < entry.phases.length; i++) {
      // Eight diagonal groups chase each other across the 8×8 tile grid.
      // Circular distance keeps the wave seamless at the period boundary.
      const rawDistance = Math.abs(wave - i);
      const distance = Math.min(rawDistance, entry.phases.length - rawDistance);
      const strength = Math.max(0, 1 - distance);
      entry.phases[i].alpha = 0.09 + strength * 0.48;
    }
  }
  for (const entry of activeChunkReveals) {
    let complete = true;
    const elapsed = now - entry.startedAt;
    for (const row of entry.sprites) {
      if (!row.sprite || row.sprite.destroyed) continue;
      const p = Math.max(0, Math.min(1, (elapsed - row.delay) / (entry.duration ?? CHUNK_REVEAL_MS)));
      const eased = p * p * (3 - 2 * p);
      row.sprite.alpha = row.finalAlpha * eased;
      if (Number.isFinite(row.finalTint) && 'tint' in row.sprite) {
        row.sprite.tint = _mixRgb(CHUNK_REVEAL_TINT, row.finalTint, eased);
      }
      if (p < 1) complete = false;
    }
    if (complete) {
      activeChunkReveals.delete(entry);
      entry.done?.();
    }
  }
  if (activeChunkShimmers.size === 0 && activeChunkReveals.size === 0) {
    Ticker.shared.remove(_chunkTransitionsTick);
    chunkTransitionTickerInstalled = false;
  }
}

function _mixRgb(from, to, amount) {
  const t = Math.max(0, Math.min(1, amount));
  const fr = (from >>> 16) & 0xFF, fg = (from >>> 8) & 0xFF, fb = from & 0xFF;
  const tr = (to >>> 16) & 0xFF, tg = (to >>> 8) & 0xFF, tb = to & 0xFF;
  const r = Math.round(fr + (tr - fr) * t);
  const g = Math.round(fg + (tg - fg) * t);
  const b = Math.round(fb + (tb - fb) * t);
  return (r << 16) | (g << 8) | b;
}

function _ensureChunkTransitionTicker() {
  if (chunkTransitionTickerInstalled) return;
  Ticker.shared.add(_chunkTransitionsTick);
  chunkTransitionTickerInstalled = true;
}

function _reducedMotionRequested() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    || globalThis.localStorage?.getItem?.('uo.reduced-motion') === '1';
}

const CHUNK_DIRECTION_VECTORS = Object.freeze([
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
]);

/** Fast conservative screen intersection for an 8×8 isometric block.
 * `tileRadius` gives a square in world coordinates and consequently queues
 * roughly twice as many chunks as the rectangular viewport can show. This
 * projection test keeps an elevation/tall-art margin while discarding those
 * invisible corner chunks before they compete for range/atlas requests. */
function _chunkIntersectsViewport(cx, cy, centerX, centerY, viewport, padPx = 0) {
  if (!viewport || !Number.isFinite(viewport.viewW) || !Number.isFinite(viewport.viewH)) return true;
  const zoom = Math.max(0.25, Number(viewport.zoom) || 1);
  const wx = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
  const wy = cy * CHUNK_SIZE + CHUNK_SIZE / 2;
  const fallbackZ = Number(viewport.centerZ) || 0;
  const wz = assets.landAt(wx | 0, wy | 0)?.z ?? fallbackZ;
  const sx = worldToScreenX(wx, wy) - worldToScreenX(centerX, centerY);
  const sy = worldToScreenY(wx, wy, wz) - worldToScreenY(centerX, centerY, fallbackZ);
  const chunkHalf = CHUNK_SIZE * TILE_HALF_W;
  const halfW = viewport.viewW / (2 * zoom);
  const halfH = viewport.viewH / (2 * zoom);
  const elevationAndTallArtPad = 96;
  return Math.abs(sx) <= halfW + chunkHalf + padPx
    && Math.abs(sy) <= halfH + chunkHalf + elevationAndTallArtPad + padPx;
}

function _isCaveLandGraphic(id) {
  const g = id | 0;
  return (g >= 0x0244 && g <= 0x024A) || (g >= 0x053B && g <= 0x0540);
}

function _isFieldGraphic(id) {
  const g = id | 0;
  return g >= FIELD_GRAPHIC_MIN && g <= FIELD_GRAPHIC_MAX;
}

function _isFoliageFlags(flags) {
  return ((flags | 0) & 0x40) !== 0 || ((flags | 0) & FLAG_FOLIAGE) !== 0;
}

function _fieldMode() {
  return String(profileManager?.get?.('ui.fieldsType') ?? 'classic').toLowerCase();
}

function _shouldAnimateStaticGraphic(id) {
  if (_isFieldGraphic(id) && _fieldMode() === 'static') return false;
  return profileManager?.get?.('debug.skipAnimData') !== true
    && isAnimdataStaticGraphic(assets.tiledata, assets.animdata, id);
}

function _profileStaticGraphic(id, flags) {
  const raw = id | 0;
  if (profileManager?.get?.('ui.hideVegetation') === true && _isFoliageFlags(flags)) return 0;
  if (profileManager?.get?.('ui.treeToStumps') === true && _isFoliageFlags(flags)) {
    const seasonal = seasonManager.remapStatic(raw);
    return seasonal !== raw ? seasonal : FOLIAGE_STUMP_GRAPHIC;
  }
  return seasonManager.remapStatic(raw);
}

function _cotAlphaFor(x, y, playerX, playerY, radius, type) {
  if (!type || radius <= 0) return 1;
  const dx = (x | 0) - (playerX | 0);
  const dy = (y | 0) - (playerY | 0);
  const d2 = dx * dx + dy * dy;
  const r2 = radius * radius;
  if (d2 > r2) return 1;
  if ((type | 0) === 1) return 0.35;
  const d = Math.sqrt(d2);
  const t = Math.max(0, Math.min(1, d / radius));
  return 0.25 + t * 0.65;
}

function _roofBoundsDebugId(bounds) {
  if (!bounds) return 'none';
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (bounds.x0 | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (bounds.y0 | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (bounds.x1 | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (bounds.y1 | 0), 16777619) >>> 0;
  return h.toString(16).slice(-6).toUpperCase();
}

function _makeCaveBorderOverlay(wx, wy, z) {
  const g = new Graphics();
  const cx = worldToScreenX(wx, wy);
  const cy = worldToScreenY(wx, wy, z);
  g.poly([0, -TILE_HALF_H, TILE_HALF_W, 0, 0, TILE_HALF_H, -TILE_HALF_W, 0], true)
    .stroke({ width: 2, color: 0x6fa8ff, alpha: 0.75 });
  g.position.set(cx, cy);
  g.zIndex = depthKey(wx, wy, z, LAYER_LAND) + 1;
  return g;
}

function _setNoColorTint(sp, on) {
  if (!sp || sp.destroyed) return;
  if (on) {
    if (sp._uoBaseTintForRange == null) sp._uoBaseTintForRange = sp.tint ?? 0xFFFFFF;
    sp.tint = 0x8c8c8c;
    return;
  }
  if (sp._uoBaseTintForRange != null) {
    sp.tint = sp._uoBaseTintForRange;
    sp._uoBaseTintForRange = null;
  }
}

function _zIndexOf(displayObject) {
  const z = displayObject?.zIndex;
  return Number.isFinite(z) ? z : 0;
}

class ChunkVisual {
  /** @param {import('pixi.js').Container} parent  flat tile layer (sortableChildren=true) */
  constructor(cx, cy, parent) {
    this.cx = cx; this.cy = cy;
    this.parent = parent;
    this._createdAt = performance.now();
    /** ready becomes true after fetchBlock + statics complete & sprites mounted */
    this.ready = false;
    /** All sprites this chunk owns — added directly to the flat parent
     *  so cross-chunk z-sort works. We keep refs here for eviction. */
    /** @type {import('pixi.js').DisplayObject[]} */
    this._sprites = [];
    /** @type {{sprite: import('pixi.js').Sprite, baseId: number}[]} */
    this._animated = [];
    /** Wet static art rendered twice like CUO AnimatedWaterEffect. */
    this._water = [];
    /** Tall statics (potential roofs / upper walls) tracked for cut-off
     *  visibility when the player walks indoors.
     *  Each entry: { sprite, z, isRoof, x, y } in world coords. */
    this._tallStatics = [];
    this._tallStaticsByTile = new Map();
    this._tallStructureScratch = createTallStructureScratch();
    /** Foliage statics (trees, bushes) — fade when player walks behind. */
    this._foliage = [];
    // Neutral placeholder under the chunk while its land atlas resolves.
    // This is a real isometric diamond, never a rectangular UI shimmer.
    this._mountChunkShimmer();
  }

  /** Build a tile-accurate shimmer for the unresolved 8×8 block. A single
   *  convex chunk diamond looked like a giant blue ribbon on elevated land:
   *  it was drawn at z=0 and filled the empty space between 64 projected
   *  tiles. Eight interleaved Graphics groups instead follow the actual land
   *  Z and produce a visible diagonal loading wave. */
  _mountChunkShimmer() {
    const gfx = new Container();
    const phases = Array.from({ length: 8 }, () => {
      const phase = new Graphics();
      phase.eventMode = 'none';
      phase.alpha = 0.09;
      gfx.addChild(phase);
      return phase;
    });
    gfx.zIndex = -1;
    gfx.eventMode = 'none';
    gfx.visible = false;
    this.parent.addChild(gfx);
    const entry = { gfx, phases, startedAt: performance.now() };
    if (!_reducedMotionRequested()) {
      activeChunkShimmers.add(entry);
      _ensureChunkTransitionTicker();
    } else {
      for (const phase of phases) phase.alpha = 0.22;
    }
    this._shimmer = {
      gfx,
      phases,
      entry,
      dispose() {
        activeChunkShimmers.delete(entry);
        try { gfx.destroy({ children: true }); } catch { /* already detached */ }
      },
    };
    this._refreshChunkShimmerGeometry();
  }

  _refreshChunkShimmerGeometry() {
    const shimmer = this._shimmer;
    if (!shimmer) return false;
    for (const phase of shimmer.phases) phase.clear();
    const x0 = this.cx * CHUNK_SIZE;
    const y0 = this.cy * CHUNK_SIZE;
    let painted = 0;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const wx = x0 + dx;
        const wy = y0 + dy;
        const tile = assets.landAt(wx, wy);
        if (!tile) continue;
        const sx = worldToScreenX(wx, wy);
        const sy = worldToScreenY(wx, wy, tile.z | 0);
        // One-pixel breathing room makes the wave read as individual land
        // tiles instead of reconstructing the old solid chunk polygon.
        shimmer.phases[Math.min(7, Math.floor((dx + dy) / 2))]
          .poly([sx, sy - 21, sx + 21, sy, sx, sy + 21, sx - 21, sy], true)
          .fill({ color: 0x9ca8b5, alpha: 1 });
        painted++;
      }
    }
    shimmer.gfx.visible = painted > 0;
    return painted > 0;
  }

  _disposeChunkShimmer(force = false) {
    if (this._landReveal && !force) return;
    if (!this._shimmer) return;
    try { this._shimmer.gfx.parent?.removeChild(this._shimmer.gfx); }
    catch { /* already detached */ }
    this._shimmer.dispose();
    this._shimmer = null;
  }

  _startLandReveal(sprites) {
    if (!sprites.length || _reducedMotionRequested()) {
      this._disposeChunkShimmer();
      return;
    }
    const entry = {
      startedAt: performance.now(),
      sprites: sprites.map((sprite) => ({
        sprite,
        finalAlpha: Number.isFinite(sprite.alpha) ? sprite.alpha : 1,
        finalTint: Number.isFinite(sprite.tint) ? sprite.tint : 0xFFFFFF,
        // A full diagonal sweep (rather than four repeating bands) makes the
        // streamed block visibly assemble from its NW edge. The last tile is
        // settled in ~550 ms: clear enough to read, still below gameplay lag.
        delay: (
          ((sprite._worldX | 0) - this.cx * CHUNK_SIZE)
          + ((sprite._worldY | 0) - this.cy * CHUNK_SIZE)
        ) * CHUNK_REVEAL_STAGGER_MS,
      })),
      done: () => {
        if (this._landReveal !== entry) return;
        this._landReveal = null;
        this._disposeChunkShimmer(true);
      },
    };
    for (const row of entry.sprites) {
      row.sprite.alpha = 0;
      if ('tint' in row.sprite) row.sprite.tint = CHUNK_REVEAL_TINT;
    }
    this._landReveal = entry;
    activeChunkReveals.add(entry);
    _ensureChunkTransitionTicker();
  }

  _cancelLandReveal() {
    if (!this._landReveal) return;
    activeChunkReveals.delete(this._landReveal);
    this._landReveal = null;
  }

  _addChunkSprites(sprites) {
    if (!Array.isArray(sprites) || sprites.length === 0) return;
    if (this._destroyed) {
      for (const sp of sprites) {
        releaseRenderObject(sp);
      }
      return;
    }
    sprites.sort((a, b) => _zIndexOf(a) - _zIndexOf(b));
    for (let i = 0; i < sprites.length; i += MAX_ADD_CHILD_BATCH) {
      this.parent.addChild(...sprites.slice(i, i + MAX_ADD_CHILD_BATCH));
    }
    this._sprites.push(...sprites);
  }

  async populate() {
    if (this.ready || this._destroyed) return;
    // Start land and statics I/O together, but never make the visible terrain
    // wait for the heavier static index/data request. The old Promise.all
    // kept entire map holes on screen until doors, roofs and decorations had
    // also arrived. Neighbour blocks are still warmed before slope meshes are
    // built because their corner Z values are required for stretching.
    const blockPromises = [
      assets.fetchBlock(this.cx, this.cy),
      assets.fetchBlock(this.cx + 1, this.cy),
      assets.fetchBlock(this.cx, this.cy + 1),
      assets.fetchBlock(this.cx + 1, this.cy + 1),
    ];
    const staticsPromise = assets.fetchStatics(this.cx, this.cy).catch(() => []);
    const block = await blockPromises[0];
    if (!block || this._destroyed) { this._disposeChunkShimmer(); return; }
    // Now that the main block exists, repaint the placeholder at the actual
    // per-tile elevation instead of z=0 while neighbour/atlas work continues.
    this._refreshChunkShimmerGeometry();
    await Promise.all(blockPromises.slice(1));
    if (this._destroyed) { this._disposeChunkShimmer(); return; }

    const x0 = this.cx * CHUNK_SIZE;
    const y0 = this.cy * CHUNK_SIZE;

    // Resolve every land + static sprite IN PARALLEL — atlas pages are
    // pre-loaded so each `mountLandSprite` await is just a Texture-create.
    /** @type {Promise<import('pixi.js').DisplayObject|null>[]} */
    const landPromises = [];
    const caveBorderTiles = profileManager?.get?.('ui.enableCaveBorder') === true ? [] : null;
    for (let dy = 0; dy < CHUNK_SIZE; dy++) {
      for (let dx = 0; dx < CHUNK_SIZE; dx++) {
        const wx = x0 + dx, wy = y0 + dy;
        // One authoritative terrain path. landAt() applies live map-editor
        // overlays and performs bounds checks; reading the raw block here
        // made rendered land disagree with walkability and slope neighbours.
        const tile = assets.landAt(wx, wy);
        if (!tile) continue;
        const id = tile.id | 0;
        const z = tile.z | 0;
        if (caveBorderTiles && _isCaveLandGraphic(id)) caveBorderTiles.push({ wx, wy, z });
        landPromises.push(this._mountLandSprite(seasonManager.remapLand(id), wx, wy, z));
      }
    }
    // allSettled instead of all so a single failed land mesh (corrupt
    // texture / Pixi runtime hiccup) doesn't skip every static in the
    // chunk via a cascading rejection.
    const landSprites = await Promise.allSettled(landPromises);
    if (this._destroyed) {
      // Wrapper got destroyed mid-populate (TP, facet swap). Drop the
      // resolved sprites instead of orphaning them on the shared parent.
      for (const r of landSprites) {
        if (r.status === 'fulfilled' && r.value) {
          releaseRenderObject(r.value);
        }
      }
      return;
    }
    const mountedLand = [];
    for (const r of landSprites) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      mountedLand.push(r.value);
    }
    this._addChunkSprites(mountedLand);
    // Reveal the opaque base over the still-pulsing isometric placeholder.
    // The shimmer disposes itself after the short diagonal fade completes.
    this._startLandReveal(mountedLand);
    if (caveBorderTiles) {
      const caveBorders = [];
      for (const t of caveBorderTiles) {
        const border = _makeCaveBorderOverlay(t.wx, t.wy, t.z);
        caveBorders.push(border);
      }
      this._addChunkSprites(caveBorders);
    }

    // Door-static suppression set for this chunk. Sourced from the
    // module-level incremental door index — populated on item:placed
    // / entity:removed events instead of re-walking world.items per
    // chunk populate. With 110k+ items in a populated shard, the
    // per-chunk full scan was the freeze culprit (iterates 110k × 30
    // visible chunks ≈ 3.3M iterations every time TP'd into a busy
    // area; each refreshSurroundings re-streams items + triggers
    // re-populates → cascade).
    const chunkKey = (this.cy << 16) | (this.cx & 0xffff);
    const suppressedDoorTiles = doorTileIndex.tilesForChunkKey(chunkKey);

    const statics = await staticsPromise;
    if (this._destroyed) return;
    const staticPromises = [];
    if (Array.isArray(statics)) {
      for (const it of statics) {
        const wx = x0 + it.x, wy = y0 + it.y;
        // Suppress map-static doors covered by a runtime item door.
        const probePiece = assets.doorPiece?.(it.id | 0);
        if (probePiece && suppressedDoorTiles.has(doorTileIndex.tileKey(wx, wy))) continue;
        // Skip placeholder "NODRAW" entries — art.mul reserves a debug
        // tile (black square with red "NO DRAW" caption) for every art
        // id whose slot was never filled by the original UO release.
        // The map files routinely reference these slots as scaffolding
        // for future content; rendering them shows up as a forest of
        // "NO DRAW" labels around the player. CUO's `Art.cs` skips
        // them via the same name check.
        // Atlas resolves the same texture via either local id OR
        // (id + 0x4000); tiledata follows the same dual layout (UO
        // SDK ships 65 536 static entries indexed by raw 16-bit ids).
        // Check both — the placeholder "NO DRAW" tile lives at the
        // GLOBAL slot for several IDs whose LOCAL entry is just empty
        // land scaffolding, and missing this fallback is exactly why
        // the user sees forests of "NO DRAW" labels at Britain.
        const tdName = staticEntry(assets.tiledata, it.id)?.name?.toLowerCase?.() ?? '';
        if (tdName.includes('nodraw')) continue;
        const tdEntry = staticEntry(assets.tiledata, it.id);
        const flags = tdEntry?.flags ?? 0;
        // Profile + season remap: winter / desolation collapse foliage
        // IDs onto a bare-stump graphic; `ui.treeToStumps` forces the
        // same readable low-visual-noise form year-round, and
        // `ui.hideVegetation` skips those sprites entirely.
        const remappedId = _profileStaticGraphic(it.id, flags);
        if (!remappedId) continue;
        const seasonHue = seasonManager.hueTint(it.id);
        const finalHue  = it.hue || seasonHue || 0;
        staticPromises.push(
          this._mountStaticSprite(remappedId, wx, wy, it.z, finalHue)
            .then((sp) => ({ sp, it, wx, wy }))
            .catch(() => ({ sp: null, it, wx, wy })),
        );
      }
    }
    const staticResults = await Promise.all(staticPromises);
    if (this._destroyed) {
      for (const { sp } of staticResults) {
        if (!sp) continue;
        releaseRenderObject(sp);
      }
      return;
    }
    const mountedStatics = [];
    for (const { sp, it, wx, wy } of staticResults) {
      if (!sp) continue;
      // CUO uses raw tileId for tiledata lookups (Art.cs:34 only adds
      // 0x4000 for the ART side, not for behavioural metadata).
      const tdEntry = staticEntry(assets.tiledata, it.id);
      const flags = tdEntry?.flags ?? 0;
      const height = tdEntry?.height ?? 0;
      // CUO TileFlag (TileDataLoader.cs:404):
      //   Background = 0x1, Translucent = 0x4, Wall = 0x10,
      //   Roof = 0x10000000, Foliage = 0x40 / 0x20000.
      // Some retail UO art pieces have inconsistent flags — the housedata
      // tables (walls.txt / roof.txt / floors.txt) carry an authoritative
      // category that the housing system uses. We OR the housedata role
      // with the flag check so a graphic listed in roof.txt is treated
      // as a roof even if its tiledata flag is missing, and same for
      // walls. Mirrors how CUO's HouseCustomizationManager keeps
      // `Roofs / Walls / Floors` lists ordered by category.
      const role = assets.houseRole?.(it.id) ?? null;
      const isRoof        = (flags & FLAG_ROOF)       !== 0 || role === 'roof';
      const isWall        = (flags & FLAG_WALL)       !== 0 || role === 'wall';
      const isSurface     = (flags & FLAG_SURFACE)    !== 0 || role === 'floor';
      const isBackground  = (flags & FLAG_BACKGROUND) !== 0;
      const isTransparent = (flags & (FLAG_TRANSLUCENT | FLAG_TRANSPARENT | FLAG_FOLIAGE)) !== 0;
      // Bridges (TileFlag.Bridge = 0x400 in CUO) are stairs / ramps —
      // navigation surfaces that must NEVER be hidden by the indoor
      // cut-off. Augment with housedata.stairs membership: 19 categories
      // × 12 pieces = 228 staircase graphics whose tiledata flag may be
      // missing (retail UO has inconsistent stair tagging on the older
      // light-wood / dark-wood sets). Earlier they fell into the `tallStatic` bucket via
      // `height >= 5` and disappeared whenever the player walked
      // anywhere with a roof above them.
      const isBridge      = (flags & FLAG_BRIDGE) !== 0 || role === 'stair';
      // Port CUO Chunk.cs:247-269 priorityZ adjustments. Without these
      // a flat (X+Y, Z) sort treats every static at the same tile as
      // equal priority and lets adjacent decorations cover mobiles or
      // hides walls behind floors. Mirrors the canonical CUO order:
      //   Background → priorityZ − 1   (carpets, dirt, light shadow tiles)
      //   Height > 0 → priorityZ + 1   (tall stuff peeks above same-tile flat items)
      let priorityZ = it.z;
      if (isBackground) priorityZ -= 1;
      if (height > 0)   priorityZ += 1;
      // Bridges (wooden planks over water/chasm): force back to floor
      // priority. Without this they had height>0 → +1 priorityZ → sorted
      // ABOVE adjacent stone supports/walls and produced the visible
      // "plank-overlapping-wall" artefact at coastlines/bridge edges.
      // Bridges are navigation surfaces — they should sort with the
      // floor, not stack above neighbouring walls.
      if (isBridge) priorityZ = it.z - 1;
      sp.zIndex = depthKey(wx, wy, priorityZ, LAYER_STATIC);
      if (sp._uoWaterOverlay) sp._uoWaterOverlay.zIndex = sp.zIndex + 0.25;
      mountedStatics.push(sp);
      if (sp._uoWaterOverlay) mountedStatics.push(sp._uoWaterOverlay);

      // Track every static that COULD cover a person-height mobile so
      // the circle-of-transparency loop can fade them. Skip bridges /
      // stairs entirely — they're floor-level navigation tiles that
      // never need the cut-off treatment, and they were vanishing the
      // moment the player walked beneath any roof.
      // ALSO skip low walls (it.z < 5): bridge stone supports register
      // as walls but live below ground level — fading them detached
      // the bridge planks from their pillars when the player crossed.
      if (!isBridge && !(isWall && it.z < 5) && (it.z >= 5 || isRoof || isWall || height >= 5)) {
        this._tallStatics.push({
          sprite: sp,
          z: it.z,
          height,
          isRoof,
          isWall,
          isSurface,
          isCeilingSurface: isSurface && !isBridge && !isWall && !isRoof && it.z >= 5,
          isTransparent,
          x: wx,
          y: wy,
          bounds: tallStaticBounds(wx, wy),
        });
      }
      // Foliage tracking — CUO `CheckIfBehindATree` fades trees covering
      // the player. tiledata Foliage flag = 0x40 OR Translucent 0x20004.
      // We treat anything with the foliage / translucent bits as fadeable.
      const isFoliage = _isFoliageFlags(flags);
      if (isFoliage && it.z >= 0) {
        this._foliage.push({ sprite: sp, x: wx, y: wy, z: it.z });
      }
    }
    this._addChunkSprites(mountedStatics);
    assignTallStructureBounds(this._tallStatics, this._tallStructureScratch);
    this._rebuildTallStaticIndex();
    this.ready = true;
    this._disposeChunkShimmer();
  }

  _rebuildTallStaticIndex() {
    this._tallStaticsByTile.clear();
    for (const t of this._tallStatics) {
      const key = _tallTileKey(t.x, t.y);
      let list = this._tallStaticsByTile.get(key);
      if (!list) {
        list = [];
        this._tallStaticsByTile.set(key, list);
      }
      list.push(t);
    }
  }

  tallStaticsAt(x, y) {
    return this._tallStaticsByTile.get(_tallTileKey(x, y)) ?? EMPTY_ARRAY;
  }

  async _mountLandSprite(id, wx, wy, z) {
    // Read the 4 corner Z heights for slope warping. Mirrors CUO
    // Land.ApplyStretch (Land.cs:96-162) — each land tile shares its
    // 4 corners with the 3 neighbours to the SE. When all 4 corners
    // are equal, render as a flat axis-aligned diamond Sprite. When
    // they differ, the diamond is warped onto a 4-vertex Mesh — that
    // is what gives UO its 3-D isometric look (slopes, hills, stairs)
    // instead of looking like an aerial top-down map.
    const zTop    = z;
    const zRight  = assets.landAt(wx + 1, wy)?.z ?? z;
    const zLeft   = assets.landAt(wx,     wy + 1)?.z ?? z;
    const zBottom = assets.landAt(wx + 1, wy + 1)?.z ?? z;
    const cornersDiffer = (zTop !== zRight) || (zTop !== zLeft) || (zTop !== zBottom);
    // ClassicUO Land.ApplyStretch does NOT stretch every tile whose four
    // corner heights differ. It first requires a valid texmaps.mul entry;
    // wet/no-texmap land and missing texmaps remain ordinary flat art.
    // Stretching raw 44x44 land-art across the 35-Z cliff jumps around
    // Trinsic (1869,2750) produced the huge blue polygons reported by the
    // user: a single water/shore diamond was pulled over ~140 screen px,
    // and dozens of adjacent tiles combined into one blocky sheet.
    const texId = landEntry(assets.tiledata, id)?.texId | 0;
    const hasTexmap = texId > 0 && !!assets.texmapAtlas?.tiles?.[texId];
    // ClassicUO stretches every non-flat land tile with a valid texmap,
    // including the authored 25–35 Z escarpments around Trinsic. Flattening
    // those transitions leaves the lower water and upper bank disconnected,
    // exposing the blue scene background as large coastline holes.
    const stretched = cornersDiffer && hasTexmap;
    // CUO chooses the smoother diagonal for AverageZ; a four-corner mean
    // makes shoreline land sort too high and exposes dark saw-teeth between
    // the z=-5 water statics and z=0 bank.
    const avgZ = stretched
      ? (Math.abs(zTop - zBottom) <= Math.abs(zLeft - zRight)
          ? ((zTop + zBottom) >> 1)
          : ((zLeft + zRight) >> 1))
      : z;

    const centerX = worldToScreenX(wx, wy);
    const centerY = worldToScreenY(wx, wy, 0);        // Z baked into yOffsets
    // Canonical CUO path (LandView.cs:58-92):
    //   stretched + texmap available  → DrawStretchedLand (warped 64×64 colour map)
    //   stretched + no texmap         → art.mul diamond, warped to slope
    //   flat                          → art.mul diamond, axis-aligned sprite
    // The art.mul bitmap already encodes the proper 44×44 diamond
    // pattern for the terrain (grass swirls, sand grain, etc.) so flat
    // tiles MUST use it — texmaps are square colour maps and warp
    // unpredictably across an axis-aligned diamond, producing the
    // pin-striped / blurry-grass look the user reported.
    if (stretched) {
      // Canonical CUO LandView path: stretched terrain is sampled from
      // texmaps.mul (a square colour map whose corners map onto the four
      // land vertices). Raw art.mul diamonds are only for flat land.
      const tmTex = await assets.texmapTexture(texId);
      if (tmTex) {
        return makeStretchedTexmap(tmTex, centerX, centerY, wx, wy, avgZ,
                                   zTop, zRight, zLeft, zBottom);
      }
      // A page can disappear between manifest lookup and async load. Fall
      // through to flat art, matching CUO's invalid-texmap safety path.
    }
    {
      const tex = assets.landTextureSync?.(id) ?? await assets.landTexture(id);
      if (tex) {
        const sp = acquireSprite(tex);
        sp.anchor.set(0.5, 0.5);
        sp.position.set(centerX, centerY - z * Z_STEP);
        // Coastline seam fix: water tiles (UO ocean range 0xA8..0xCC)
        // get a -1 zIndex bias so when they sit at the same iso row
        // as a shoreline grass tile, the grass wins the tie-break and
        // the seam looks clean. Without this two adjacent tiles at
        // (X+Y)=row had identical depth and Pixi sortChildren picked
        // them in insertion order (visually random per chunk re-mount).
        const isWater = id >= 0xA8 && id <= 0xCC;
        sp.zIndex = depthKey(wx, wy, z, LAYER_LAND) + (isWater ? -1 : 0);
        sp._worldX = wx | 0; sp._worldY = wy | 0; sp._worldZ = z | 0; sp._uoKind = 'land';
        return sp;
      }
    }
    // Fallback: colored diamond so we never leave a gap. 1-pixel
    // padding on each axis closes seams between adjacent diamonds when
    // the GPU samples them with anti-aliasing.
    const g = new Graphics();
    const color = landIdFallbackColor(id);
    const HW = TILE_HALF_W + 1;
    const HH = TILE_HALF_H + 1;
    if (stretched) {
      // Warped fill — same vertex math as makeStretchedLand below.
      g.poly([
        0,           -zTop    * Z_STEP - HH + TILE_HALF_H,
        HW,           -zRight * Z_STEP,
        0,            -zBottom * Z_STEP + HH + TILE_HALF_H,
        -HW,          -zLeft   * Z_STEP,
      ], true);
    } else {
      g.poly([0, -HH, HW, 0, 0, HH, -HW, 0], true);
    }
    g.fill({ color, alpha: 1 });
    g.position.set(centerX, centerY);
    g.zIndex = depthKey(wx, wy, avgZ, LAYER_LAND) - 1;
    g._worldX = wx | 0; g._worldY = wy | 0; g._worldZ = avgZ | 0; g._uoKind = 'land-fallback';
    return g;
  }

  async _mountStaticSprite(id, wx, wy, z, hue) {
    const tex = assets.staticTextureSync?.(id) ?? await assets.staticTexture(id);
    if (!tex) return null;
    const centerX = worldToScreenX(wx, wy);
    const centerY = worldToScreenY(wx, wy, z);
    const sp = acquireSprite(tex);
    sp.anchor.set(0.5, 1);
    sp.position.set(centerX, centerY + TILE_HALF_H);
    sp.zIndex = depthKey(wx, wy, z, LAYER_STATIC);
    sp._worldX = wx | 0; sp._worldY = wy | 0; sp._worldZ = z | 0; sp._uoKind = 'static';
    if (hue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(sp, hue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    // Track animated statics — `tick(now)` swaps their texture each frame.
    // CRITICAL: gate on tiledata TileFlag.Animation BEFORE consulting
    // animdata. The animdata.mul ships entries for many art ids that are
    // NOT tagged as animated in tiledata (0x154d water barrel has frames
    // but is just ArticleA), so animating every animdata row morphs
    // ordinary objects into unrelated art. CUO gates the same way via
    // `TileDataLoader.StaticData[Graphic].IsAnimated`.
    if (_shouldAnimateStaticGraphic(id)) {
      this._animated.push({ sprite: sp, baseId: id });
    }
    // ClassicUO `DrawStaticAnimated(..., isWet:true)` paints wet statics a
    // second time with a slow sine/cosine scale. UO rivers are primarily
    // 0x1797..0x17B2 wet STATICS at z=-5 laid over lower land, so animating
    // land ids alone does nothing. Keep the base sharp and add a low-alpha
    // centred overlay to get motion without the harsh shoreline overdraw of
    // two fully opaque browser sprites.
    const flags = staticEntry(assets.tiledata, id)?.flags ?? 0;
    if ((flags & FLAG_WET) !== 0 && profileManager?.get?.('graphics.animatedWater') !== false) {
      const overlay = acquireSprite(tex);
      overlay.anchor.set(0.5, 1);
      overlay.position.copyFrom(sp.position);
      overlay.zIndex = sp.zIndex + 0.25;
      overlay.alpha = 0.18;
      if (hue && assets.huesTexture && assets.huesMeta) {
        applyHueTo(overlay, hue, 1, assets.huesTexture, assets.huesMeta.count);
      }
      sp._uoWaterOverlay = overlay;
      this._water.push({ sprite: sp, overlay, phase: ((wx * 17 + wy * 31) & 63) / 63 });
    }
    // Register a point light for known emitters (torches, fireplaces,
    // lava, etc.). Stored on the sprite so chunk eviction can release.
    const litSpec = staticLightSpec(id);
    if (litSpec) {
      sp._lightId = lightPoints.add({
        x: wx, y: wy, z: z | 0,
        radius: litSpec.radius, color: litSpec.color,
        lightIndex: litSpec.lightIndex,
        flicker: litSpec.flicker,
        pulse: litSpec.pulse,
        pulseSpeed: litSpec.pulseSpeed,
      });
    }
    return sp;
  }

  /** Per-frame: re-resolve animated static textures. Cheap sync lookup
   *  when atlas pages are warm; async fallback is scheduled at most once
   *  per pending frame id. */
  tick(nowMs) {
    if (!this._animated.length && !this._water.length) return;
    if (this._water.length) {
      const t = nowMs / 1000;
      const intensity = Math.max(0, Math.min(2, Number(profileManager?.get?.('graphics.waterIntensity')) || 1));
      for (const w of this._water) {
        if (!w.overlay || w.overlay.destroyed) continue;
        const phase = t + w.phase * 0.7;
        w.overlay.scale.set(
          1 + intensity * (0.045 + Math.sin(phase) * 0.025),
          1 + intensity * (0.035 + Math.cos(phase) * 0.018),
        );
        w.overlay.alpha = Math.min(0.35, intensity * (0.14 + (Math.sin(phase * 0.8) + 1) * 0.035));
      }
    }
    for (const a of this._animated) {
      const id = assets.currentAnimatedGraphic(a.baseId, nowMs);
      if (id === a.sprite._lastAnimId) continue;
      const cached = assets.staticTextureSync?.(id);
      if (cached) {
        a.sprite.texture = cached;
        if (a.sprite._uoWaterOverlay) a.sprite._uoWaterOverlay.texture = cached;
        a.sprite._lastAnimId = id;
        a._pendingAnimId = 0;
        continue;
      }
      if (a._pendingAnimId === id) continue;
      a._pendingAnimId = id;
      const generation = a.sprite._uoPoolGeneration;
      assets.staticTexture(id).then((tex) => {
          if (tex && a._pendingAnimId === id && a.sprite && !a.sprite.destroyed
              && a.sprite._uoPoolGeneration === generation) {
            a.sprite.texture = tex;
            if (a.sprite._uoWaterOverlay) a.sprite._uoWaterOverlay.texture = tex;
          a.sprite._lastAnimId = id;
        }
      }).finally(() => {
        if (a._pendingAnimId === id) a._pendingAnimId = 0;
      }).catch(() => { /* ignore */ });
    }
  }

  destroy() {
    // Set BEFORE freeing sprites so any in-flight populate awaits drop
    // their resolved sprites instead of pushing them onto a now-orphan
    // parent. See populate() for the matching `if (this._destroyed)`
    // guards after each await point.
    this._destroyed = true;
    this._cancelLandReveal();
    this._disposeChunkShimmer(true);
    this._animated.length = 0;
    this._water.length = 0;
    this._tallStatics.length = 0;
    this._tallStaticsByTile.clear();
    this._foliage.length = 0;
    for (const sp of this._sprites) {
      // Release any registered point light so the lightPoints registry
      // doesn't accumulate stale entries from evicted chunks.
      if (sp?._lightId) {
        try { lightPoints.remove(sp._lightId); } catch { /* ignore */ }
        sp._lightId = null;
      }
      // Sprites and stretched-land meshes have separate bounded pools.
      if (sp?._uoWaterOverlay) sp._uoWaterOverlay = null;
      releaseRenderObject(sp);
    }
    this._sprites.length = 0;
  }
}

/** Stretched-land mesh using a 64×64 texmaps.mul texture. The texmap
 *  is an *axis-aligned* square colour map (not a diamond) — UV (0,0)
 *  is the texture corner that maps to the diamond's TOP vertex, then
 *  going clockwise: (1,0)→Right, (1,1)→Bottom, (0,1)→Left. CUO does
 *  this implicitly via _cornerOffsetX/Y in Batcher2D.cs:263-274. */
function makeStretchedTexmap(tex, centerX, centerY, wx, wy, depthZ,
                             zTop, zRight, zLeft, zBottom) {
  const yT = -zTop    * Z_STEP;
  const yR = TILE_HALF_H - zRight  * Z_STEP;
  const yL = TILE_HALF_H - zLeft   * Z_STEP;
  const yB = TILE_H      - zBottom * Z_STEP;
  const vertices = new Float32Array([
    TILE_HALF_W, yT,   // 0: top
    TILE_W,      yR,   // 1: right
    0,           yL,   // 2: left
    TILE_HALF_W, yB,   // 3: bottom
  ]);
  // Texmap UV — the four square corners go to the four diamond corners.
  // CUO _cornerOffsetX = {0,1,0,1}, _cornerOffsetY = {0,0,1,1} mapped to
  // Top/Right/Left/Bottom respectively (Batcher2D.cs:263-274).
  //
  // We pull half a texel off each edge. Texmaps are packed shoulder-to-
  // shoulder in a 2048×2048 atlas with NO padding, so a UV of exactly 1
  // would sample the FIRST pixel of the next cell (a different terrain
  // texture entirely), producing the "noisy grass" / colour-bleed
  // artefact visible on flat fields. Standalone CUO textures don't
  // need this because GPU CLAMP_TO_EDGE catches them — atlases force us
  // to inset manually.
  const tw = tex.frame?.width  ?? tex.width  ?? 64;
  const th = tex.frame?.height ?? tex.height ?? 64;
  const insetU = 0.5 / tw;
  const insetV = 0.5 / th;
  const uvs = new Float32Array([
    insetU,     insetV,         // 0 top    ← corner (0,0)
    1 - insetU, insetV,         // 1 right  ← corner (1,0)
    insetU,     1 - insetV,     // 2 left   ← corner (0,1)
    1 - insetU, 1 - insetV,     // 3 bottom ← corner (1,1)
  ]);
  const indices = new Uint32Array([
    0, 1, 3,   // top, right, bottom
    0, 3, 2,   // top, bottom, left
  ]);
  const mesh = acquireLandMesh(tex, vertices, uvs, indices);
  // Disable Pixi's per-frame onRender callback. Land vertices are
  // immutable for the lifetime of the mesh, so the auto-update
  // callback (which reads `this.geometry.getBuffer('aPosition')`) just
  // wastes a call. More importantly, it crashes after destroy(): the
  // RenderGroup keeps the onRender entry one frame past removeChild
  // and `geometry` is already null. Setting onRender=null removes it
  // from the renderGroup callback list entirely.
  mesh.autoUpdate = false;
  mesh.onRender = null;
  mesh.position.set(centerX - TILE_HALF_W, centerY - TILE_HALF_H);
  mesh.zIndex = depthKey(wx, wy, depthZ, LAYER_LAND);
  // Tiny diagnostic payload used by the exact-coordinate browser smoke. It
  // also makes a live renderer dump identify which authored cliff produced a
  // mesh without retaining any atlas/image data.
  mesh._uoLandX = wx | 0;
  mesh._uoLandY = wy | 0;
  mesh._worldX = wx | 0;
  mesh._worldY = wy | 0;
  mesh._worldZ = depthZ | 0;
  mesh._uoKind = 'land-mesh';
  mesh._uoLandCornerDelta = Math.max(zTop, zRight, zLeft, zBottom)
    - Math.min(zTop, zRight, zLeft, zBottom);
  return mesh;
}

/** Hash a land id to a stable RGB colour. id=0 used to be black which
 *  produced visible diagonal gaps between chunks; we map it to ocean
 *  blue instead. */
function landIdFallbackColor(id) {
  if (!id) return 0x143a5a;                            // empty → ocean
  if (id >= 0xA8 && id <= 0xCC) return 0x143a5a;       // ocean
  if (id >= 0xC0 && id <= 0xE0) return 0x4d3a20;       // dirt
  if (id >= 0x21B && id <= 0x230) return 0x5e5b54;     // stone
  if (id < 0x40) return 0x1c4a22;                      // grass-ish
  let h = ((id * 0x9E3779B1) ^ (id << 5)) >>> 0;
  return ((h & 0x7f) + 0x40) << 16 | (((h >>> 8) & 0x7f) + 0x60) << 8 | (((h >>> 16) & 0x7f) + 0x40);
}

/** Visual layer for items the server placed via 0x1A / 0xF3 / multis.
 *  Mounted alongside terrain chunks but evicted independently. */
class WorldItemSprite {
  constructor(serial) {
    this.serial = serial >>> 0;
    /** @type {Sprite | null} */
    this.sprite = null;
    /** for multis, an array of additional sprites (one per child tile) */
    this.children = [];
    this.mountGeneration = 0;
  }
  destroy() {
    this.mountGeneration = ((this.mountGeneration | 0) + 1) >>> 0;
    if (this.sprite) {
      releaseRenderObject(this.sprite);
    }
    for (const c of this.children) {
      releaseRenderObject(c);
    }
    this.children.length = 0;
    this.sprite = null;
  }
}

export class TileRenderer {
  /** @param {import('pixi.js').Container} parent */
  constructor(parent) {
    this.parent = parent;
    /** Flat z-sorting: every land/static/item/mobile sprite for the whole
     *  visible world is a direct child of this container, sorted by
     *  zIndex from depthKey(). Mirrors CUO's GameSceneDrawingSorting. */
    this.parent.sortableChildren = true;
    /** @type {Map<number, ChunkVisual>} */
    this.visuals = new Map();
    /** @type {Map<number, WorldItemSprite>} server-placed items / multis */
    this.items = new Map();
    this._animatedItems = [];
    /** Dynamic placed items that count as "tall" for indoor / roof-cut /
     *  circle-of-transparency logic. Static map statics get tracked via
     *  `ChunkVisual._tallStatics`; placemulti / dynamic spawns mount
     *  through `_mountItem` and bypass that path, so the player walked
     *  into a `[placemulti` house and the roof never faded. Keyed by
     *  serial; value is the array of per-tile entries (multi anchors
     *  produce many sprites, one per tall constituent tile). `_removeItem`
     *  drops the whole array in O(1) so a despawned house clears cleanly.
     *  @type {Map<number, Array<{ sprite: import('pixi.js').Sprite,
     *    z: number, height: number, isRoof: boolean, isWall: boolean,
     *    isTransparent: boolean, x: number, y: number }>>} */
    this._dynamicTalls = new Map();
    this._dynamicTallsByTile = new Map();
    this._dynamicTallDirtySerials = new Set();
    this._dynamicTallsRevision = 0;
    this._chunkRevision = 0;
    this._lastStaticAnimTickMs = 0;
    // update() already prefetches one complete ring outside the viewport.
    // Keeping two additional rings retained 13x13=169 chunks for a 640x480
    // game window (the exact HUD value from the report), increasing sort and
    // atlas pressure without reducing pop-in. One warm ring is sufficient.
    this.loadPad = 1;
    this._visibleChunkStamp = 0;
    this._dynamicTallBoxScratch = [];
    this._dynamicTallBoxStamp = 0;
    this._roofScopeScratch = [];
    this._dynamicSerialScratch = new Set();
    this._dynamicStillDirtyScratch = new Set();
    this._cotOverlay = null;
    this._roofDebugOverlay = null;
    this._roofDebugLabel = null;
    this._chunkDebugOverlay = new Graphics();
    this._chunkDebugOverlay.eventMode = 'none';
    this._chunkDebugOverlay.zIndex = 0x7ffff0;
    this.parent.addChild(this._chunkDebugOverlay);
    this._zDepthDebugLabel = new Text({ text: '', style: ROOF_DEBUG_LABEL_STYLE });
    this._zDepthDebugLabel.eventMode = 'none';
    this._zDepthDebugLabel.visible = false;
    this._zDepthDebugLabel.zIndex = 0x7ffff1;
    this.parent.addChild(this._zDepthDebugLabel);
    this._facetGeneration = 1;

    /** Queue for `item:placed` bursts (TP refresh streams 100+ in one
     *  tick). Each item:placed used to fire `_mountItem` immediately,
     *  flooding the microtask queue with 100+ unawaited Promises that
     *  starved the next animation frame. We now buffer them and drain
     *  N per RAF, giving Pixi a chance to render between bursts.
     *  @type {Array<any>} */
    this._mountQueue = [];
    this._mountQueueHead = 0;
    this._mountRaf = 0;
    this._pendingInvalidate = new Set();
    /** Chunk construction is deliberately frame-budgeted. Creating every
     * visible 8×8 chunk at once drained thousands of cached texture promises
     * in one microtask wave (the 600 ms long tasks visible in the debug HUD).
     * Three chunks may resolve concurrently and the next group starts on the
     * following animation frame, nearest-to-player first. */
    this._chunkPopulateQueue = [];
    this._chunkPopulateActive = 0;
    this._chunkPopulateRaf = 0; // compatibility diagnostic; streaming uses _streamScheduler
    this._chunkDrainScheduled = false;
    this._mountDrainScheduled = false;
    this._streamScheduler = new FrameTaskScheduler();
    this._maxChunkPopulates = clientRuntimeProfile.chunkPopulates ?? MAX_CHUNK_POPULATES;
    this._mountBatchSize = clientRuntimeProfile.mountBatch ?? 32;
    this._streamFrameAt = 0;
    this._streamFrameEma = 16.7;
    this._previewBrush = null;
    this._housePreviewSprite = null;
    this._housePreviewGraphic = 0;
    this._housePreviewPendingGraphic = 0;
    this._housePreviewLoadSeq = 0;
    this._unsubs = [
      bus.on('item:placed',    (it) => this._enqueueMount(it)),
      bus.on('entity:removed', ({ serial }) => this._removeItem(serial)),
      bus.on('corpse:facing-changed', ({ serial }) => {
        const it = world.items.get(serial >>> 0);
        if (!it) return;
        this._removeItem(serial);
        this._enqueueMount(it);
      }),
      // Multi-facet: when the player crosses a moongate / teleporter the
      // server sends 0xBF 0x08 → asset-manager flips the active facet and
      // emits this event. Tear down every chunk visual + world-item sprite
      // so the next `update()` rehydrates from the new facet's bins.
      bus.on('facet:changed', () => this._resetForFacetChange()),
      bus.on('debug:tile-selected', ({ x, y } = {}) => {
        this._debugTile = Number.isFinite(x) && Number.isFinite(y) ? { x: x | 0, y: y | 0 } : null;
      }),
      // Map editor live update: admin painted a tile, asset-manager
      // updated its overlay map, fires `chunk:invalidate` per affected
      // 8×8 chunk. Tear down the chunk visual so the next update()
      // re-mounts it via assets.landAt() (which now returns the new
      // tileId from the overlay).
      bus.on('chunk:invalidate', ({ cx, cy }) => this._invalidateChunk(cx, cy)),
      bus.on('profile:changed', ({ path } = {}) => {
        if (!path) return;
        if (path === 'ui.treeToStumps'
            || path === 'ui.hideVegetation'
            || path === 'ui.enableCaveBorder'
            || path === 'ui.fieldsType'
            || path === 'graphics.animatedWater'
            || path === 'debug.skipAnimData') {
          this._remountVisualWorld();
          return;
        }
        if (path === 'ui.circleOfTransparencyType'
            || path === 'ui.circleOfTransparencyRadius'
            || path === 'graphics.hideUnderRoof'
            || path === 'debug.cotOverlay'
            || path === 'debug.roofOverlay') {
          this._chunkRevision = (this._chunkRevision + 1) >>> 0;
        }
      }),
      // Exact ClassicUO season tables can replace both land and statics,
      // therefore a season transition must rebuild loaded chunks.
      bus.on('season:changed', () => {
        this._remountVisualWorld();
      }),
      bus.on('frame:tick', (now) => {
        if (this._streamFrameAt) {
          const frameMs = Math.max(1, Math.min(250, Number(now) - this._streamFrameAt));
          this._streamFrameEma = this._streamFrameEma * 0.9 + frameMs * 0.1;
          const background = globalThis.document?.hidden === true;
          const stressed = background || this._streamFrameEma > 24;
          const healthy = !background && this._streamFrameEma < 18;
          this._maxChunkPopulates = stressed ? 1 : healthy ? clientRuntimeProfile.chunkPopulates : Math.min(2, clientRuntimeProfile.chunkPopulates);
          this._mountBatchSize = stressed ? Math.min(10, clientRuntimeProfile.mountBatch) : healthy ? clientRuntimeProfile.mountBatch : Math.min(20, clientRuntimeProfile.mountBatch);
        }
        this._streamFrameAt = Number(now) || performance.now();
        this._streamScheduler.observeFrame(this._streamFrameEma);
        this._streamScheduler.drain();
      }),
      // Audit #46 P3 — House-customization preview brush. When the
      // user picks a new tile in the editor we tint the ghost sprite
      // under the cursor so they preview placement before clicking.
      // `house-customization-manager` emits `house:brush-changed`.
      bus.on('house:brush-changed', (info) => {
        try {
          this._previewBrush = info ?? null;
          if (!info?.graphic) this._clearHousePreview();
        } catch { /* ignore */ }
      }),
    ];
  }

  /**
   * Schedule chunk invalidation. Deferred to next animation frame so a
   * burst of events (e.g. refreshSurroundings re-streaming 50 items
   * after a TP — each door triggers an invalidation) collapses into
   * ONE destroy+remount per chunk instead of N. Without coalescing the
   * client froze for several seconds when teleporting into Britain
   * Bank (8 doors → 8 cascaded chunk re-mounts, each launching its
   * own Promise.all of texture loads while the previous wasn't done).
   */
  _invalidateChunk(cx, cy) {
    const key = (cy << 16) | (cx & 0xffff);
    const vis = this.visuals.get(key);
    if (!vis) return;          // not mounted yet — populate will pick up live data
    // Skip mid-populate chunks: their static loop hasn't run yet, so it
    // will read the (already-up-to-date) door-suppression set when it
    // does. Destroying a mid-populate chunk leaks the in-flight sprites
    // (Promise.all keeps adding children to a `parent` that's still
    // alive even though our wrapper is gone), and worse — update()
    // creates a NEW ChunkVisual immediately and starts populate AGAIN.
    // Over a few TPs into a busy bank that cascade is the real freeze
    // cause: 8 doors × 3 cascading repopulations × Promise.all of ~100
    // texture loads each.
    if (!vis.ready) return;
    this._pendingInvalidate.add(key);
    if (this._invalidateRaf) return;
    this._invalidateRaf = requestAnimationFrame(() => {
      this._invalidateRaf = 0;
      const keys = this._pendingInvalidate;
      for (const k of keys) {
        const v = this.visuals.get(k);
        if (v) {
          v.destroy();
          this.visuals.delete(k);
          this._chunkRevision = (this._chunkRevision + 1) >>> 0;
        }
        if (this._chunkIdleSince) this._chunkIdleSince.delete(k);
      }
      keys.clear();
    });
  }

  _clearChunkPopulateQueue() {
    this._chunkPopulateQueue.length = 0;
    this._streamScheduler.cancelOwner(this);
    this._chunkDrainScheduled = false;
    this._mountDrainScheduled = false;
    if (this._chunkPopulateRaf) {
      cancelAnimationFrame(this._chunkPopulateRaf);
      this._chunkPopulateRaf = 0;
    }
  }

  diagnosticsSnapshot() {
    let stale = 0;
    for (const [key] of this.visuals) if (!this._visibleChunkKeys?.has?.(key)) stale++;
    return {
      chunks: this.visuals.size,
      readyChunks: [...this.visuals.values()].filter((chunk) => chunk.ready).length,
      queuedChunks: this._chunkPopulateQueue.length,
      activePopulates: this._chunkPopulateActive,
      staleChunks: stale,
      queuedItems: Math.max(0, this._mountQueue.length - this._mountQueueHead),
      maxChunkPopulates: this._maxChunkPopulates,
      mountBatchSize: this._mountBatchSize,
      frameEmaMs: Number(this._streamFrameEma.toFixed(2)),
      revision: this._chunkRevision >>> 0,
      scheduler: { ...this._streamScheduler.stats, budgetMs: this._streamScheduler.budgetMs },
      landMeshes: landMeshPool.stats(),
      softLimit: clientRuntimeProfile.chunkSoftLimit,
      hardLimit: clientRuntimeProfile.chunkHardLimit,
      staleAlarms: this._staleChunkAlarms | 0,
      populateTimings: [...this.visuals.values()]
        .filter((chunk) => Number.isFinite(chunk._populateMs))
        .sort((a, b) => b._populateMs - a._populateMs)
        .slice(0, 12)
        .map((chunk) => ({ cx: chunk.cx, cy: chunk.cy, ms: Number(chunk._populateMs.toFixed(2)), at: chunk._populateFinishedAt ?? 0 })),
      lastPopulateAt: Math.max(0, ...[...this.visuals.values()].map((chunk) => Number(chunk._populateFinishedAt) || 0)),
    };
  }

  _scheduleChunkPopulate(vis, centerCx, centerCy, tier = 0) {
    if (!vis || vis._populateQueued || vis.ready || vis._destroyed) return;
    vis._populateQueued = true;
    const dx = vis.cx - centerCx;
    const dy = vis.cy - centerCy;
    const [vx, vy] = CHUNK_DIRECTION_VECTORS[(world.player?.direction ?? 0) & 7];
    const directionalLead = dx * vx + dy * vy;
    // Visible chunks always outrank prefetch. Within a tier, prefer nearby
    // chunks and then the direction the player is moving towards.
    vis._populatePriority = (tier | 0) * 10_000 + (dx * dx + dy * dy) * 100 - directionalLead * 8;
    vis._populateTier = tier | 0;
    vis._queuedAt = performance.now();
    this._chunkPopulateQueue.push(vis);
    this._requestChunkPopulateDrain();
  }

  _requestChunkPopulateDrain() {
    if (this._chunkDrainScheduled || this._chunkPopulateQueue.length === 0) return;
    this._chunkDrainScheduled = true;
    const priority = this._chunkPopulateQueue.some((chunk) => (chunk._populateTier | 0) === 0) ? 0 : 2;
    this._streamScheduler.schedule('chunks:drain', () => {
      this._chunkDrainScheduled = false;
      this._drainChunkPopulateQueue();
    }, { priority, owner: this });
  }

  _drainChunkPopulateQueue() {
    while (this._chunkPopulateActive < this._maxChunkPopulates
        && this._chunkPopulateQueue.length > 0) {
      // Queue sizes are bounded by the visible chunk window (~170). A linear
      // nearest lookup is cheaper than maintaining a heap across teleports
      // and lets a newly-visible centre chunk overtake old prefetch work.
      let best = 0;
      for (let i = 1; i < this._chunkPopulateQueue.length; i++) {
        if ((this._chunkPopulateQueue[i]._populatePriority ?? Infinity)
            < (this._chunkPopulateQueue[best]._populatePriority ?? Infinity)) best = i;
      }
      const vis = this._chunkPopulateQueue.splice(best, 1)[0];
      vis._populateQueued = false;
      if (vis._destroyed || vis.ready || this.visuals.get((vis.cy << 16) | (vis.cx & 0xffff)) !== vis) {
        continue;
      }
      this._chunkPopulateActive++;
      const populateStartedAt = performance.now();
      vis._populateStartedAt = populateStartedAt;
      vis.populate()
        .then(() => {
          vis._populateMs = performance.now() - populateStartedAt;
          vis._populateFinishedAt = Date.now();
          this._chunkRevision = (this._chunkRevision + 1) >>> 0;
        })
        .catch((e) => {
          vis._disposeChunkShimmer();
          vis._populateError = e;
          console.error('[tile] populate failed', e);
        })
        .finally(() => {
          this._chunkPopulateActive = Math.max(0, this._chunkPopulateActive - 1);
          // Yield to paint even when all atlas promises were already cached.
          this._requestChunkPopulateDrain();
        });
    }
  }

  _resetForFacetChange() {
    this._facetGeneration++;
    this._clearChunkPopulateQueue();
    for (const vis of this.visuals.values()) vis.destroy();
    this.visuals.clear();
    if (this._chunkIdleSince) this._chunkIdleSince.clear();
    // World-item sprites placed by the server on the *previous* facet are
    // already invalid coords for the new facet — drop them. The server
    // will re-broadcast 0x1A / 0xF3 for visible items on the new facet.
    for (const it of this.items.values()) it.destroy();
    this.items.clear();
    doorTileIndex.clear();
    this._animatedItems.length = 0;
    this._dynamicTalls.clear();
    this._dynamicTallsByTile.clear();
    this._dynamicTallDirtySerials.clear();
    this._dynamicTallsRevision = (this._dynamicTallsRevision + 1) >>> 0;
    this._chunkRevision = (this._chunkRevision + 1) >>> 0;
    this._mountQueue.length = 0;
    this._mountQueueHead = 0;
    if (this._mountRaf) {
      cancelAnimationFrame(this._mountRaf);
      this._mountRaf = 0;
    }
    if (this._invalidateRaf) {
      cancelAnimationFrame(this._invalidateRaf);
      this._invalidateRaf = 0;
    }
    if (this._pendingInvalidate) this._pendingInvalidate.clear();
    // Client perf round 2 #8: also clear the TP-jump detector so the
    // first `update()` on the new facet doesn't compare against the
    // OLD facet's coordinates and skip the distant-chunk eviction.
    this._lastCenterX = null;
    this._lastCenterY = null;
    this._clearRoofDebugOverlay();
  }

  _remountVisualWorld() {
    this._facetGeneration++;
    this._clearChunkPopulateQueue();
    for (const vis of this.visuals.values()) vis.destroy();
    this.visuals.clear();
    if (this._chunkIdleSince) this._chunkIdleSince.clear();
    for (const it of this.items.values()) it.destroy();
    this.items.clear();
    doorTileIndex.clear();
    this._animatedItems.length = 0;
    this._dynamicTalls.clear();
    this._dynamicTallsByTile.clear();
    this._dynamicTallDirtySerials.clear();
    this._dynamicTallsRevision = (this._dynamicTallsRevision + 1) >>> 0;
    this._chunkRevision = (this._chunkRevision + 1) >>> 0;
    this._mountQueue.length = 0;
    this._mountQueueHead = 0;
    if (this._mountRaf) {
      cancelAnimationFrame(this._mountRaf);
      this._mountRaf = 0;
    }
    if (this._invalidateRaf) {
      cancelAnimationFrame(this._invalidateRaf);
      this._invalidateRaf = 0;
    }
    if (this._pendingInvalidate) this._pendingInvalidate.clear();
    try {
      for (const it of world.items.values()) {
        if (!it || it.parent) continue;
        this._enqueueMount(it);
      }
    } catch { /* best-effort remount */ }
  }

  /** Buffer `item:placed` and drain N per animation frame. Avoids the
   *  microtask flood that froze the renderer when refreshSurroundings
   *  blasted 100+ items in one tick — each `_mountItem` chain awaited
   *  staticTexture, addChild on the sortableChildren parent flagged
   *  sortDirty, and 100 chains' microtasks drained before the next
   *  RAF could fire. With drain-at-RAF the work spreads across ~5
   *  frames, sortChildren runs once per drain, and the user sees the
   *  area gradually populate (already invisible to them since the TP
   *  itself is the "snap"). */
  _enqueueMount(it) {
    if (!it) return;
    this._mountQueue.push(it);
    if (this._mountDrainScheduled) return;
    const drain = () => {
      this._mountDrainScheduled = false;
      const BATCH = this._mountBatchSize;
      const start = this._mountQueueHead | 0;
      const end = Math.min(start + BATCH, this._mountQueue.length);
      for (let i = start; i < end; i++) {
        const next = this._mountQueue[i];
        // _mountItem is async (texture loads). Fire-and-forget is
        // fine — failures are swallowed and the next RAF will
        // continue draining.
        try { this._mountItem(next).catch(() => { /* ignore */ }); }
        catch { /* synchronous throw — skip */ }
      }
      this._mountQueueHead = end;
      if (this._mountQueueHead >= this._mountQueue.length) {
        this._mountQueue.length = 0;
        this._mountQueueHead = 0;
      }
      if (this._mountQueue.length) {
        this._mountDrainScheduled = true;
        this._streamScheduler.schedule('items:mount', drain, { priority: 1, owner: this });
      }
    };
    this._mountDrainScheduled = true;
    this._streamScheduler.schedule('items:mount', drain, { priority: 1, owner: this });
  }

  /** Classify a static sprite for indoor / roof-cut visibility tracking.
   *  Mirrors the chunk path's `_tallStatics` filter (see populate(): the
   *  `if (!isBridge && !(isWall && it.z < 5) …)` block). Returns an
   *  entry object when the tile should be tracked, else null. */
  _classifyTall(tileId, wx, wy, wz, sprite, opts = {}) {
    const tdEntry = staticEntry(assets.tiledata, tileId);
    const flags   = tdEntry?.flags ?? 0;
    const height  = tdEntry?.height ?? 0;
    const role    = assets.houseRole?.(tileId) ?? null;
    const isRoof        = (flags & FLAG_ROOF)       !== 0 || role === 'roof';
    const isWall        = (flags & FLAG_WALL)       !== 0 || role === 'wall';
    const isSurface     = (flags & FLAG_SURFACE)    !== 0 || role === 'floor';
    const isBackground  = (flags & FLAG_BACKGROUND) !== 0;
    const isTransparent = (flags & (FLAG_TRANSLUCENT | FLAG_TRANSPARENT | FLAG_FOLIAGE)) !== 0;
    const isBridge      = (flags & FLAG_BRIDGE)     !== 0 || role === 'stair';
    if (isBridge) return null;
    if (isWall && wz < 5) return null;
    if (!(wz >= 5 || isRoof || isWall || height >= 5)) return null;
    void isBackground;
    return {
      sprite,
      z: wz,
      height,
      isRoof,
      isWall,
      isSurface,
      isCeilingSurface: isSurface && !isBridge && !isWall && !isRoof && wz >= 5,
      isTransparent,
      x: wx,
      y: wy,
      sourceSerial: opts.sourceSerial ? (opts.sourceSerial >>> 0) : 0,
      bounds: opts.bounds ?? tallStaticBounds(wx, wy),
    };
  }

  _setDynamicTalls(serial, entries) {
    const s = serial >>> 0;
    this._deleteDynamicTalls(s);
    if (!entries?.length) return;
    this._dynamicTalls.set(s, entries);
    for (const t of entries) {
      t.ownerSerial = s;
      const key = _tallTileKey(t.x, t.y);
      let list = this._dynamicTallsByTile.get(key);
      if (!list) {
        list = [];
        this._dynamicTallsByTile.set(key, list);
      }
      list.push(t);
    }
    this._dynamicTallDirtySerials.add(s);
    this._dynamicTallsRevision = (this._dynamicTallsRevision + 1) >>> 0;
  }

  _deleteDynamicTalls(serial) {
    const s = serial >>> 0;
    const entries = this._dynamicTalls.get(s);
    if (!entries) return;
    this._dynamicTalls.delete(s);
    this._dynamicTallDirtySerials.delete(s);
    for (const t of entries) {
      const key = _tallTileKey(t.x, t.y);
      const list = this._dynamicTallsByTile.get(key);
      if (!list) continue;
      const idx = list.indexOf(t);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this._dynamicTallsByTile.delete(key);
    }
    this._dynamicTallsRevision = (this._dynamicTallsRevision + 1) >>> 0;
  }

  dynamicTallsAt(x, y) {
    return this._dynamicTallsByTile?.get?.(_tallTileKey(x, y)) ?? EMPTY_ARRAY;
  }

  _dynamicTallsInBox(x0, y0, x1, y1) {
    const out = this._dynamicTallBoxScratch ?? (this._dynamicTallBoxScratch = []);
    out.length = 0;
    let stamp = ((this._dynamicTallBoxStamp + 1) >>> 0);
    if (stamp === 0) stamp = 1;
    this._dynamicTallBoxStamp = stamp;
    if (!this._dynamicTallsByTile) {
      for (const entries of this._dynamicTalls?.values?.() ?? []) {
        for (const t of entries) {
          if (t._boxStamp === stamp) continue;
          t._boxStamp = stamp;
          out.push(t);
        }
      }
      return out;
    }
    for (let y = y0 | 0; y <= (y1 | 0); y++) {
      for (let x = x0 | 0; x <= (x1 | 0); x++) {
        const list = this.dynamicTallsAt(x, y);
        for (const t of list) {
          if (t._boxStamp === stamp) continue;
          t._boxStamp = stamp;
          out.push(t);
        }
      }
    }
    return out;
  }

  _playItemSpawnShimmer(sp, startedAt = performance.now()) {
    if (!sp || sp.destroyed) return;
    const baseAlpha = Number.isFinite(sp.alpha) ? sp.alpha : 1;
    const baseScaleX = sp.scale?.x ?? 1;
    const baseScaleY = sp.scale?.y ?? 1;
    const generation = sp._uoPoolGeneration;
    sp.alpha = 0;
    if (sp.scale?.set) sp.scale.set(baseScaleX * 0.94, baseScaleY * 0.94);
    const DURATION_MS = 260;
    const tick = (now) => {
      if (!sp || sp.destroyed || sp._uoPoolGeneration !== generation) return;
      const t = Math.max(0, Math.min(1, (now - startedAt) / DURATION_MS));
      const pulse = Math.sin(t * Math.PI * 3) * (1 - t) * 0.03;
      sp.alpha = baseAlpha * (0.12 + 0.88 * t);
      if (sp.scale?.set) sp.scale.set(
        baseScaleX * (0.94 + 0.06 * t + pulse),
        baseScaleY * (0.94 + 0.06 * t + pulse),
      );
      if (t < 1) requestAnimationFrame(tick);
      else {
        if (!sp || sp.destroyed || sp._uoPoolGeneration !== generation) return;
        sp.alpha = baseAlpha;
        if (sp.scale?.set) sp.scale.set(baseScaleX, baseScaleY);
      }
    };
    requestAnimationFrame(tick);
  }

  async _mountItem(it) {
    let vis = this.items.get(it.serial);
    const isFirstSeen = !vis;
    if (!vis) {
      vis = new WorldItemSprite(it.serial);
      this.items.set(it.serial, vis);
    } else {
      vis.destroy();
    }
    const mountGeneration = (vis.mountGeneration = ((vis.mountGeneration | 0) + 1) >>> 0);
    const stale = () => this.items.get(it.serial) !== vis
      || vis.mountGeneration !== mountGeneration;
    // Drop any prior tall-entry list for this serial — `_mountItem` is
    // re-entrant on re-broadcast (hue change, item update) and the old
    // sprites were just destroyed above.
    this._deleteDynamicTalls(it.serial);
    // Maintain incremental door-suppression index. A door item arrival
    // updates the chunk's set + invalidates the chunk visual so the
    // populate's static loop will see the suppression next frame.
    // DoorTileIndex register/unregister operations keep the
    // index in O(items in chunk) on edge events instead of O(items)
    // per chunk populate.
    if (it.itemId && doorTileIndex.graphicState(it.itemId | 0)) {
      doorTileIndex.register(it);
      this._invalidateChunk(Math.floor(it.x / CHUNK_SIZE), Math.floor(it.y / CHUNK_SIZE));
      // Smooth door swing — fade the freshly-mounted door sprite in over
      // ~160 ms when the user enabled `ui.smoothDoors` (default true).
      // Real UO doors don't keyframe-rotate; this just softens the snap.
      // Mark the item so the next sprite mount in this turn picks up
      // the fade — the actual lerp runs from inside _mountStaticAt
      // when it sees `_swingPending`.
      if (profileManager?.get?.('ui.smoothDoors') !== false) {
        it._swingPending = performance.now();
      }
    }
    if (it.multiId) {
      // Render every tile of the multi at (it.x + dx, it.y + dy, it.z + dz).
      const tiles = assets.multiTiles(it.multiId);
      if (tiles) {
        const prepared = [];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const t of tiles) {
          if (!t.visible) continue;
          const n = staticEntry(assets.tiledata, t.id)?.name?.toLowerCase?.() ?? '';
          if (n.includes('nodraw')) continue;
          const wx = it.x + t.x, wy = it.y + t.y, wz = it.z + t.z;
          prepared.push({ t, wx, wy, wz });
          if (wx < x0) x0 = wx;
          if (wy < y0) y0 = wy;
          if (wx > x1) x1 = wx;
          if (wy > y1) y1 = wy;
        }
        const bounds = prepared.length ? { x0, y0, x1, y1 } : null;
        const tallList = [];
        for (const { t, wx, wy, wz } of prepared) {
          const sp = await this._mountStaticAt(t.id, wx, wy, wz, it.hue);
          if (!sp) continue;
          if (stale()) { releaseSprite(sp); return; }
          sp._worldX = wx | 0;
          sp._worldY = wy | 0;
          if (isFirstSeen) this._playItemSpawnShimmer(sp);
          vis.children.push(sp);
          const tall = this._classifyTall(t.id, wx, wy, wz, sp, {
            sourceSerial: it.serial,
            bounds,
          });
          if (tall) tallList.push(tall);
        }
        if (tallList.length) this._setDynamicTalls(it.serial, tallList);
      }
    } else if (it.isCorpse) {
      // Corpse — use the death animation frame for the live body. The
      // server sends the corpse's "amount" field as the live body id
      // (ServUO convention); fall back to looking up via Corpse.def.
      const liveBody = it.amount || it.itemId;
      const corpseInfo = assets.resolveCorpseBody(liveBody);
      const animBody = corpseInfo?.corpseBody ?? liveBody;
      const facing = corpseManager.getCorpseFacing(it.serial);
      const sp = await this._mountCorpseSprite(
        animBody,
        it.x,
        it.y,
        it.z,
        it.hue || corpseInfo?.corpseHue || 0,
        facing,
      );
      if (sp) {
        if (stale()) { releaseSprite(sp); return; }
        vis.sprite = sp;
        if (it._deathRevealAt > performance.now()) {
          this._revealCorpseSprite(sp, it._deathRevealAt);
        } else if (isFirstSeen) this._playItemSpawnShimmer(sp);
      } else {
        // Unsupported/custom bodies still leave a visible loot target.
        const fallback = await this._mountStaticAt(0x2006, it.x, it.y, it.z, it.hue || 0);
        if (fallback) {
          if (stale()) { releaseSprite(fallback); return; }
          fallback._worldX = it.x | 0;
          fallback._worldY = it.y | 0;
          vis.sprite = fallback;
        }
      }
    } else if (it.itemId) {
      const displayItemId = displayItemIdForAmount(it.itemId, it.amount);
      // Same NODRAW filter as the chunk populate path: art.mul reserves
      // a debug placeholder ("NO DRAW" caption) for unused art ids and
      // ServUO occasionally references them when authoring decorations.
      // Check both local and global tiledata slots (UO 65 536-entry
      // static table) since the atlas resolves either path.
      const n = staticEntry(assets.tiledata, displayItemId)?.name?.toLowerCase?.() ?? '';
      if (n.includes('nodraw')) return;
      // Tall sprites (moongates, large fountains) get a depth-key bias
      // so their lower half doesn't end up behind the SE-neighbour
      // floor tile. Detected by item graphic id since the wire packet
      // doesn't carry a `tallSprite` flag.
      const isTall =
           displayItemId === 0x0F6C            // Trammel public moongate
        || displayItemId === 0x0DDA            // Felucca public moongate
        || displayItemId === 0x1FD4;           // Tokuno public moongate
      const sp = await this._mountStaticAt(displayItemId, it.x, it.y, it.z, it.hue, { tallSprite: isTall });
      if (sp) {
        if (stale()) { releaseSprite(sp); return; }
        sp._worldX = it.x | 0;
        sp._worldY = it.y | 0;
        vis.sprite = sp;
        if (isFirstSeen && !it._swingPending) this._playItemSpawnShimmer(sp);
        // Static-light registration — forges, sconces, street lanterns,
        // braziers etc. that arrive as ITEMS (placed by [decorate /
        // doorgen / xmlspawners) need to register with `lightPoints`
        // so the LightOverlay subtracts a glow around them at night.
        // Previously only baked-into-the-map STATICS got light (the
        // tile-renderer chunk path at line ~493 calls staticLightSpec);
        // items missed entirely → forges dark at night. User report
        // 2026-05-18 "uliczne latarnie nie generują światła".
        const litSpec = staticLightSpec(it.itemId | 0);
        if (litSpec) {
          // Release any prior light id when re-mounting (item update,
          // hue change). _dynamicTalls clear above handles tall sprites
          // but the light id lives on `vis`.
          if (vis._lightId) {
            try { lightPoints.remove(vis._lightId); } catch { /* ignore */ }
          }
          vis._lightId = lightPoints.add({
            x: it.x, y: it.y, z: it.z | 0,
            radius: litSpec.radius, color: litSpec.color,
            lightIndex: litSpec.lightIndex,
            flicker: litSpec.flicker,
            pulse: litSpec.pulse,
            pulseSpeed: litSpec.pulseSpeed,
          });
        }
        // Wave 16: showcase glass effect. itemId 0x10A6 is the
        // server-side display case sprite. Render it semi-transparent
        // with additive blend so it reads as glass + a soft glow,
        // signalling "this is special" without a custom shader.
        if (it.itemId === 0x10A6) {
          sp.alpha = 0.72;
          sp.blendMode = 'add';
        }
        // Door art swaps in place. Keep a short opacity settle but never
        // rotate around a synthetic pivot: UO's open/closed graphics already
        // encode the changed footprint, and pivot compensation visibly moved
        // doors to a neighbouring tile for one frame before snapping back.
        if (it._swingPending) {
          const startAt = it._swingPending;
          sp.alpha = 0;
          const generation = sp._uoPoolGeneration;
          const tween = (now) => {
            if (sp.destroyed || sp._uoPoolGeneration !== generation) return;
            const t = Math.min(1, (now - startAt) / 100);
            sp.alpha = 0.35 + t * 0.65;
            if (t < 1) requestAnimationFrame(tween);
          };
          requestAnimationFrame(tween);
          it._swingPending = 0;
        }
        // Single-item placemulti tiles (one tile per dynamic item) and
        // generic decoration walls / roofs spawned as dynamic statics
        // also need indoor / roof-cut tracking.
        const tall = this._classifyTall(it.itemId, it.x, it.y, it.z, sp);
        if (tall) this._setDynamicTalls(it.serial, [tall]);
      }
    }
  }

  async _mountCorpseSprite(animBody, wx, wy, wz, hue, facing = { dir: 0, run: false }) {
    // Resolve body-type-specific death group and canonical 8→5 direction.
    // The old hard-coded People group 21 + direction 0 rendered animals with
    // the wrong action and made every corpse face south-east. CUO leaves a
    // corpse pinned on the final frame of the fall animation.
    const anim = new MobileAnimation();
    anim.setBody(animBody);
    anim.setDirection(facing?.dir ?? 0);
    anim.setAction(facing?.run ? Action.DieBack : Action.DieFwd);
    const group = anim.currentGroupId();
    const first = await assets.mobileFrameTexture(animBody, group, anim.direction, 0);
    const finalFrame = Math.max(0, (first?.frameCount | 0) - 1);
    const tex = finalFrame > 0
      ? (await assets.mobileFrameTexture(animBody, group, anim.direction, finalFrame) ?? first)
      : first;
    if (!tex) return null;
    const centerX = worldToScreenX(wx, wy);
    const centerY = worldToScreenY(wx, wy, wz);
    const sp = acquireSprite(tex.texture);
    if (tex.w > 0 && tex.h > 0) sp.anchor.set(tex.cx / tex.w, (tex.h + tex.cy) / tex.h);
    else sp.anchor.set(0.5, 1);
    sp.scale.x = anim.mirror ? -1 : 1;
    sp.position.set(centerX, centerY + TILE_HALF_H);
    sp.zIndex = depthKey(wx, wy, wz, LAYER_ITEM);
    sp._worldX = wx | 0;
    sp._worldY = wy | 0;
    const effectiveHue = assets.mobileRenderHue?.(animBody, hue) ?? hue;
    if (effectiveHue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(sp, effectiveHue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    this.parent.addChild(sp);
    return sp;
  }

  async _mountStaticAt(itemId, wx, wy, wz, hue, opts = {}) {
    const originalItemId = itemId | 0;
    const originalEntry = staticEntry(assets.tiledata, originalItemId);
    const originalFlags = originalEntry?.flags ?? 0;
    itemId = _profileStaticGraphic(originalItemId, originalFlags);
    if (!itemId) return null;
    const tex = assets.staticTextureSync?.(itemId) ?? await assets.staticTexture(itemId);
    if (!tex) return null;
    const centerX = worldToScreenX(wx, wy);
    const centerY = worldToScreenY(wx, wy, wz);
    const sp = acquireSprite(tex);
    sp.anchor.set(0.5, 1);
    sp.position.set(centerX, centerY + TILE_HALF_H);
    sp._worldX = wx | 0;
    sp._worldY = wy | 0;
    // depthKey advance: tall multi-tile sprites that VISUALLY extend
    // into the south-east neighbour tile (moongates, fountains) get a
    // sort bias so the SE floor doesn't render on top of their lower
    // half. The bias is +1 on both X and Y in iso (= +2 rows) which
    // promotes them past the immediate SE row but keeps them under
    // mobiles standing two rows away. Caller passes `tallSprite:true`.
    const xb = wx + (opts.tallSprite ? 1 : 0);
    const yb = wy + (opts.tallSprite ? 1 : 0);
    // Same priorityZ adjustment the chunk static path uses (see
    // ChunkVisual.populate). Without this, placemulti tiles that share
    // an iso row never get reordered by their semantic role: a flagged
    // BACKGROUND floor at z=0 and a same-tile decoration at z=0
    // collide on the (x+y, z) key, and Pixi falls back to insertion
    // order — visible as floor-on-walls / props-under-floor when a
    // multi has overlapping authored tiles. Mirroring the chunk rule
    // (background −1, height>0 +1, bridge floor-priority) brings multi
    // depth ordering in line with the static map. Marcin: "podloga
    // jest na ścianach / źle renderowane".
    const tdEntry = staticEntry(assets.tiledata, itemId);
    const flags  = tdEntry?.flags ?? 0;
    const height = tdEntry?.height ?? 0;
    const role   = assets.houseRole?.(itemId) ?? null;
    const isRoof       = (flags & 0x10000000) !== 0 || role === 'roof';
    const isWall       = (flags & 0x10)       !== 0 || role === 'wall';
    const isBackground = (flags & 0x1)        !== 0;
    const isBridge     = (flags & 0x400)      !== 0 || role === 'stair';
    let priorityZ = wz;
    if (isBackground) priorityZ -= 1;
    if (height > 0)   priorityZ += 1;
    if (isBridge)     priorityZ = wz - 1;
    // Walls + roofs need to sort ABOVE same-tile floors even when the
    // height field on the tiledata entry happens to be 0 (some retail
    // wall art has height=0). Force the +1 bump via the housedata role.
    if ((isWall || isRoof) && height === 0) priorityZ = wz + 1;
    sp.zIndex = depthKey(xb, yb, priorityZ, LAYER_ITEM);
    if (hue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(sp, hue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    this.parent.addChild(sp);
    // Track world-items whose graphic sits in animdata.entries (moongates,
    // forge fires, lava, fountain water, etc.) so the per-frame tick can
    // swap their texture. Without this, server-placed animated statics
    // froze on frame 0 — moongates lit but didn't pulse.
    // Same Animation-flag gate as chunk path (see _mountStaticSprite):
    // animdata ships entries for items that AREN'T tagged as animated
    // in tiledata, and cycling them produces the barrel/banner morph.
    if (_shouldAnimateStaticGraphic(itemId)) {
      if (!this._animatedItems) this._animatedItems = [];
      this._animatedItems.push({ sprite: sp, baseId: itemId, x: wx | 0, y: wy | 0 });
    }
    return sp;
  }

  _revealCorpseSprite(sp, revealAt) {
    if (!sp) return;
    // Interactive corpses must never be fully invisible. Keep a ghosted
    // silhouette under the last death frame, then settle to full opacity.
    sp.alpha = 0.24;
    const generation = sp._uoPoolGeneration;
    const step = (now) => {
      if (sp.destroyed || sp._uoPoolGeneration !== generation) return;
      if (now < revealAt) { requestAnimationFrame(step); return; }
      const t = Math.min(1, (now - revealAt) / 160);
      sp.alpha = 0.24 + t * 0.76;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _clearHousePreview() {
    this._housePreviewLoadSeq++;
    this._housePreviewGraphic = 0;
    this._housePreviewPendingGraphic = 0;
    if (this._housePreviewSprite) {
      releaseSprite(this._housePreviewSprite);
      this._housePreviewSprite = null;
    }
  }

  async _ensureHousePreviewSprite(graphic) {
    const g = graphic | 0;
    if (!g) {
      this._clearHousePreview();
      return;
    }
    if (this._housePreviewSprite && this._housePreviewGraphic === g) return;
    if (this._housePreviewPendingGraphic === g) return;
    this._clearHousePreview();
    this._housePreviewPendingGraphic = g;
    const seq = ++this._housePreviewLoadSeq;
    const tex = assets.staticTextureSync?.(g) ?? await assets.staticTexture(g);
    if (seq !== this._housePreviewLoadSeq) return;
    this._housePreviewPendingGraphic = 0;
    if (!tex) return;
    const sp = acquireSprite(tex);
    sp.anchor.set(0.5, 1);
    sp.eventMode = 'none';
    sp.alpha = 0.58;
    sp.tint = 0x80e8ff;
    this.parent.addChild(sp);
    this._housePreviewSprite = sp;
    this._housePreviewGraphic = g;
  }

  _updateHousePreview() {
    const brush = this._previewBrush;
    const graphic = brush?.graphic | 0;
    if (!houseCustomization.isPreviewActive?.() || !graphic) {
      this._clearHousePreview();
      return;
    }
    const x = houseCustomization.previewX | 0;
    const y = houseCustomization.previewY | 0;
    const z = houseCustomization.previewZ | 0;
    if (!this._housePreviewSprite || this._housePreviewGraphic !== graphic) {
      this._ensureHousePreviewSprite(graphic).catch(() => { /* preview is best-effort */ });
      return;
    }
    const sp = this._housePreviewSprite;
    sp.visible = true;
    sp.alpha = brush.kind === 'roof' ? 0.48 : 0.58;
    sp.tint = brush.kind === 'roof' ? 0xffd080 : 0x80e8ff;
    sp.position.set(worldToScreenX(x, y), worldToScreenY(x, y, z) + TILE_HALF_H);
    sp.zIndex = depthKey(x, y, z + 1, LAYER_ITEM) + 1;
  }

  /** Compute the "max draw Z" — anything above this height at the
   *  player's tile is hidden so the camera can see inside buildings.
   *
   *  Mirrors CUO `GameSceneDrawingSorting.UpdateMaxDrawZ` (lines
   *  57-213): walk the player's tile and look for the lowest non-roof,
   *  non-foliage, non-translucent static that sits above us. That
   *  static's z becomes the cutoff — every roof / wall / decoration
   *  above is hidden so the avatar isn't covered by its own ceiling.
   *
   *  Returns `Infinity` when the player is outdoors (no cutoff). */
  _computeMaxDrawZ(px, py, pz) {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cy = Math.floor(py / CHUNK_SIZE);
    let maxZ = Infinity;
    // CUO `UpdateMaxDrawZ` only triggers the indoor cutoff for actual
    // CEILINGS / WALLS — small props (tables, beds, anvils, urns) at
    // elevated z don't form a roof and must not be treated as one.
    // User report 2026-05-19 "podszedłem do stołu i zniknęły mi
    // przedmioty z niego" was: a table at z=5 set maxDrawZ=5, then
    // every item sitting on top of it (also at z=5) got `t.z >= 5`
    // and was hidden. Tighten the filter to roofs, elevated surfaces
    // (Britain Bank-style ceiling/floor layers), and tall walls so only
    // legitimate ceilings hide stuff above them.
    const consider = (t) => {
      if (t.isTransparent) return;
      // CUO samples the player's exact cell, plus the south-east neighbour
      // for slanted roof pieces. Component bounds are only used after cover
      // is established. Using the whole rectangle here classified streets
      // and courtyards as indoors and removed every connected roof.
      const onPlayerTile = (t.x | 0) === (px | 0) && (t.y | 0) === (py | 0);
      const onRoofProbe = !!t.isRoof
        && (t.x | 0) === ((px | 0) + 1)
        && (t.y | 0) === ((py | 0) + 1);
      if (!onPlayerTile && !onRoofProbe) return;
      // Only roofs, elevated surface ceilings, or tall walls (height
      // >= 20 forms an actual ceiling, not just a low pedestal) qualify.
      // Random decor on a table is `isRoof: false`, `isWall: false`,
      // `height < 20` → never considered.
      if (!t.isRoof && !t.isCeilingSurface && !(t.isWall && (t.height | 0) >= 20)) return;
      if (t.z > pz + 14 && t.z < maxZ) maxZ = t.z;
    };
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = ((cy + dy) << 16) | ((cx + dx) & 0xffff);
        const vis = this.visuals.get(key);
        if (!vis || !vis.ready) continue;
        for (const t of vis._tallStatics) consider(t);
      }
    }
    // Dynamic placed walls / roofs (e.g. `[placemulti houses`) also count
    // toward the indoor cutoff — without this branch the player walked
    // into a placed house and the renderer stayed in "outdoor" mode, so
    // the roof never faded even though the avatar was clearly underneath.
    for (const t of this._dynamicTallsInBox((px | 0) - 1, (py | 0) - 1, (px | 0) + 1, (py | 0) + 1)) consider(t);
    return maxZ;
  }

  _removeItem(serial) {
    const s = serial >>> 0;
    // If this was a registered door, drop it from the suppression
    // index + invalidate the chunk so the underlying map-static door
    // re-appears on the next populate.
    if (doorTileIndex.has(s)) {
      const key = doorTileIndex.unregister(s);
      this._invalidateChunk(key & 0xffff, key >>> 16);
    }
    this._deleteDynamicTalls(s);
    const vis = this.items.get(s);
    if (!vis) return;
    if (vis._lightId) {
      try { lightPoints.remove(vis._lightId); } catch { /* ignore */ }
      vis._lightId = null;
    }
    vis.destroy();
    this.items.delete(s);
  }

  _applyItemRangeColor(playerX, playerY) {
    const enabled = profileManager?.get?.('graphics.noColorObjectsOutOfRange') === true;
    const range = Math.max(1, (world.viewRange | 0) || 18);
    for (const vis of this.items.values()) {
      const sprites = vis.sprite ? [vis.sprite, ...vis.children] : vis.children;
      for (const sp of sprites) {
        if (!sp) continue;
        const x = sp._worldX;
        const y = sp._worldY;
        const out = enabled && Number.isFinite(x) && Number.isFinite(y)
          && (Math.abs((x | 0) - playerX) > range || Math.abs((y | 0) - playerY) > range);
        _setNoColorTint(sp, out);
      }
    }
  }

  _clearCotDebugOverlay() {
    const g = this._cotOverlay;
    if (!g) return;
    this._cotOverlay = null;
    try { g.parent?.removeChild(g); } catch { /* ignore */ }
    try { g.destroy(); } catch { /* ignore */ }
  }

  _clearRoofDebugOverlay() {
    const g = this._roofDebugOverlay;
    const label = this._roofDebugLabel;
    this._roofDebugOverlay = null;
    this._roofDebugLabel = null;
    try { g?.parent?.removeChild(g); } catch { /* ignore */ }
    try { label?.parent?.removeChild(label); } catch { /* ignore */ }
    try { g?.destroy(); } catch { /* ignore */ }
    try { label?.destroy(); } catch { /* ignore */ }
  }

  _updateCotDebugOverlay(playerX, playerY, playerZ, radius, type) {
    const enabled = type > 0
      && radius > 0
      && profileManager?.get?.('debug.cotOverlay') === true;
    if (!enabled) {
      if (this._cotOverlay) {
        this._cotOverlay.clear();
        this._cotOverlay.visible = false;
      }
      return;
    }
    const g = this._cotOverlay || (this._cotOverlay = new Graphics());
    if (!g.parent) this.parent.addChild(g);
    g.visible = true;
    g.renderable = true;
    g.eventMode = 'none';
    const cx = worldToScreenX(playerX, playerY);
    const cy = worldToScreenY(playerX, playerY, playerZ);
    const rx = Math.max(TILE_W, radius * TILE_W);
    const ry = Math.max(TILE_H, radius * TILE_H);
    const hard = (type | 0) === 1;
    g.clear();
    g.ellipse(cx, cy, rx, ry)
      .fill({ color: hard ? 0xffd36a : 0x7fcfff, alpha: 0.045 })
      .stroke({ width: 2, color: hard ? 0xffd36a : 0x7fcfff, alpha: 0.75 });
    g.ellipse(cx, cy, Math.max(TILE_HALF_W, rx * 0.45), Math.max(TILE_HALF_H, ry * 0.45))
      .stroke({ width: 1, color: 0xffffff, alpha: 0.25 });
    g.zIndex = depthKey(playerX | 0, playerY | 0, (playerZ | 0) + 60, LAYER_ITEM);
  }

  _updateRoofDebugOverlay(bounds, playerX, playerY, playerZ) {
    const enabled = !!bounds && profileManager?.get?.('debug.roofOverlay') === true;
    if (!enabled) {
      if (this._roofDebugOverlay) {
        this._roofDebugOverlay.clear();
        this._roofDebugOverlay.visible = false;
      }
      if (this._roofDebugLabel) this._roofDebugLabel.visible = false;
      return;
    }
    const g = this._roofDebugOverlay || (this._roofDebugOverlay = new Graphics());
    const label = this._roofDebugLabel || (this._roofDebugLabel = new Text({
      text: '',
      style: ROOF_DEBUG_LABEL_STYLE,
    }));
    if (!g.parent) this.parent.addChild(g);
    if (!label.parent) this.parent.addChild(label);
    g.visible = true;
    g.renderable = true;
    g.eventMode = 'none';
    label.visible = true;
    label.renderable = true;
    label.eventMode = 'none';

    const x0 = bounds.x0 | 0;
    const y0 = bounds.y0 | 0;
    const x1 = bounds.x1 | 0;
    const y1 = bounds.y1 | 0;
    const z = (playerZ | 0) + 8;
    const points = [
      worldToScreenX(x0, y0),         worldToScreenY(x0, y0, z),
      worldToScreenX(x1 + 1, y0),     worldToScreenY(x1 + 1, y0, z),
      worldToScreenX(x1 + 1, y1 + 1), worldToScreenY(x1 + 1, y1 + 1, z),
      worldToScreenX(x0, y1 + 1),     worldToScreenY(x0, y1 + 1, z),
    ];
    g.clear();
    g.poly(points, true)
      .fill({ color: 0xffd36a, alpha: 0.045 })
      .stroke({ width: 2, color: 0xffd36a, alpha: 0.85 });
    g.zIndex = depthKey(playerX | 0, playerY | 0, (playerZ | 0) + 62, LAYER_ITEM);

    const cx = (x0 + x1 + 1) / 2;
    const cy = (y0 + y1 + 1) / 2;
    label.text = `roof ${_roofBoundsDebugId(bounds)} ${x0},${y0}-${x1},${y1}`;
    label.position.set((worldToScreenX(cx, cy) + 0.5) | 0, ((worldToScreenY(cx, cy, z) - 18) + 0.5) | 0);
    label.zIndex = g.zIndex + 1;
  }

  update(centerX, centerY, tileRadius, now = performance.now(), viewport = null) {
    if (!assets.mapMeta) {
      // Assets not yet loaded — fall back to a single dark backdrop so the
      // viewport isn't blank.
      return;
    }
    this._updateHousePreview();

    // Teleport detection — base the jump test on `world.player.x/y`
    // (logical tile position), NOT on the camera centre. The camera
    // can pan / lerp / re-centre on a focused mobile WITHOUT the
    // player actually teleporting; if we relied on centreX/centreY,
    // a free-cam pan or follow-target switch would trigger
    // `_pruneDistantItems` and clobber loaded chunks the player
    // hadn't actually left. ServUO only sends `removeEntity` (0x1D)
    // when a player TRULY loses perception, so the eviction must be
    // gated on that — the player's logical tile.
    const px = (world?.player?.x ?? centerX) | 0;
    const py = (world?.player?.y ?? centerY) | 0;
    this._applyItemRangeColor(px, py);
    const lastX = this._lastPlayerX, lastY = this._lastPlayerY;
    this._lastPlayerX = px;
    this._lastPlayerY = py;
    if (lastX != null && lastY != null) {
      const jumpDx = Math.abs(px - lastX);
      const jumpDy = Math.abs(py - lastY);
      if (jumpDx > 18 || jumpDy > 18) {
        this._evictDistantChunksHard(centerX, centerY, tileRadius);
        this._pruneDistantItems(px, py);
      }
    }

    // Animate statics (water/fire/smoke) — tick every chunk *currently
    // intersecting the camera viewport*. Off-screen chunks (e.g. ones
    // kept warm by `loadPad` but outside the visible window) keep their
    // last-painted texture and are skipped. The throttle matches the
    // minimum animdata frame interval, so we avoid re-checking hundreds
    // of animated water / fire tiles on every browser frame.
    const x0 = centerX - tileRadius, y0 = centerY - tileRadius;
    const x1 = centerX + tileRadius, y1 = centerY + tileRadius;
    const cx0 = Math.floor(x0 / CHUNK_SIZE), cy0 = Math.floor(y0 / CHUNK_SIZE);
    const cx1 = Math.floor(x1 / CHUNK_SIZE), cy1 = Math.floor(y1 / CHUNK_SIZE);
    if (now - this._lastStaticAnimTickMs >= STATIC_ANIM_TICK_MS) {
      this._lastStaticAnimTickMs = now;
      for (const vis of this.visuals.values()) {
        if (!vis.ready) continue;
        if (vis.cx < cx0 || vis.cx > cx1 || vis.cy < cy0 || vis.cy > cy1) continue;
        if (vis._animated.length === 0 && vis._water.length === 0) continue;
        vis.tick(now);
      }
      // World-item animation tick — moongates / fire pits / fountains /
      // any item that lives in animdata.entries. Same cadence as chunk
      // animation; cheap (just a texture-pointer swap, no allocations).
      // Self-prune destroyed entries so the array doesn't grow forever
      // on a long session of moongate teardowns.
      if (this._animatedItems && this._animatedItems.length > 0) {
        let writeIdx = 0;
        for (let i = 0; i < this._animatedItems.length; i++) {
          const a = this._animatedItems[i];
          if (!a.sprite || a.sprite.destroyed) continue;
          this._animatedItems[writeIdx++] = a;
          if (a.x < x0 - 8 || a.x > x1 + 8 || a.y < y0 - 8 || a.y > y1 + 8) continue;
          const id = assets.currentAnimatedGraphic(a.baseId, now);
          if (id === a.sprite._lastAnimId) continue;
          const cached = assets.staticTextureSync?.(id);
          if (cached) {
            a.sprite.texture = cached;
            a.sprite._lastAnimId = id;
            a._pendingAnimId = 0;
            continue;
          }
          if (a._pendingAnimId === id) continue;
          a._pendingAnimId = id;
          const generation = a.sprite._uoPoolGeneration;
          assets.staticTexture(id).then((tex) => {
            if (tex && a._pendingAnimId === id && a.sprite && !a.sprite.destroyed
                && a.sprite._uoPoolGeneration === generation) {
              a.sprite.texture = tex;
              a.sprite._lastAnimId = id;
            }
          }).finally(() => {
            if (a._pendingAnimId === id) a._pendingAnimId = 0;
          }).catch(() => { /* ignore */ });
        }
        this._animatedItems.length = writeIdx;
      }
    }

    // Roof / upper-floor cut-off — port of CUO `UpdateMaxDrawZ`
    // (GameSceneDrawingSorting.cs:57-213). Find the lowest non-roof,
    // non-foliage, non-translucent static at the player's tile that
    // sits above us; everything ≥ that z is hidden so the avatar isn't
    // covered by its own ceiling. ALSO hide any roof at z ≥ player+5
    // when the cutoff fires (CUO's `_noDrawRoofs` flag).
    const playerZ = world.player?.z ?? 0;
    const playerX = world.player?.x ?? 0;
    const playerY = world.player?.y ?? 0;
    // Roof autohide can be disabled via the OptionsGump (Graphics →
    // "Hide statics under roof"). When false we report "outdoors" so the
    // hide path never trips. Default true (matches CUO behaviour).
    const roofHideOn = profileManager?.get?.('graphics.hideUnderRoof') !== false;
    const roofPassX = playerX | 0;
    const roofPassY = playerY | 0;
    const roofPassZ = playerZ | 0;
    const roofPassRadius = Math.ceil(tileRadius) | 0;
    const roofPassHide = roofHideOn ? 1 : 0;
    const cotType = Math.max(0, Math.min(2, profileManager?.get?.('ui.circleOfTransparencyType') | 0));
    const cotRadius = Math.max(0, Math.min(30, profileManager?.get?.('ui.circleOfTransparencyRadius') | 0));
    const roofOverlayOn = profileManager?.get?.('debug.roofOverlay') === true ? 1 : 0;
    this._updateCotDebugOverlay(playerX, playerY, playerZ, cotRadius, cotType);
    const roofPassChunkRev = this._chunkRevision >>> 0;
    const roofPassDynamicRev = this._dynamicTallsRevision >>> 0;
    if (roofPassX !== this._lastRoofPassX
        || roofPassY !== this._lastRoofPassY
        || roofPassZ !== this._lastRoofPassZ
        || roofPassRadius !== this._lastRoofPassRadius
        || roofPassHide !== this._lastRoofPassHide
        || cotType !== this._lastCotType
        || cotRadius !== this._lastCotRadius
        || roofOverlayOn !== this._lastRoofOverlayOn
        || roofPassChunkRev !== this._lastRoofPassChunkRev
        || roofPassDynamicRev !== this._lastRoofPassDynamicRev) {
      this._lastRoofPassX = roofPassX;
      this._lastRoofPassY = roofPassY;
      this._lastRoofPassZ = roofPassZ;
      this._lastRoofPassRadius = roofPassRadius;
      this._lastRoofPassHide = roofPassHide;
      this._lastCotType = cotType;
      this._lastCotRadius = cotRadius;
      this._lastRoofOverlayOn = roofOverlayOn;
      this._lastRoofPassChunkRev = roofPassChunkRev;
      this._lastRoofPassDynamicRev = roofPassDynamicRev;
      const playerCx = Math.floor(playerX / CHUNK_SIZE);
      const playerCy = Math.floor(playerY / CHUNK_SIZE);
      // Tall-static roof processing only matters
      // for chunks near the cut-off area. The earlier loop
      // walked every loaded chunk regardless — with 30+ chunks loaded
      // after several TPs that was 30 × ~50 tall statics = 1500
      // alpha/visible writes per frame on far-away statics. Bound the
      // chunk walk to a 2-chunk margin around the player and use
      // _tallDirty (same pattern as _foliageDirty) so chunks leaving
      // the proximity zone restore their default alpha/visible exactly
      // once instead of staying mid-faded forever.
      const TALL_CHUNK_PAD = Math.max(3, Math.ceil(tileRadius / CHUNK_SIZE));
      const roofMinX = playerX - TALL_CHUNK_PAD * CHUNK_SIZE;
      const roofMinY = playerY - TALL_CHUNK_PAD * CHUNK_SIZE;
      const roofMaxX = playerX + TALL_CHUNK_PAD * CHUNK_SIZE;
      const roofMaxY = playerY + TALL_CHUNK_PAD * CHUNK_SIZE;
      const roofCut = playerZ + 5;
      let roofStructureBounds = null;
      const roofScope = this._roofScopeScratch ?? (this._roofScopeScratch = []);
      roofScope.length = 0;
      for (const vis of this.visuals.values()) {
        if (!vis.ready) continue;
        if (Math.abs(vis.cx - playerCx) > TALL_CHUNK_PAD
            || Math.abs(vis.cy - playerCy) > TALL_CHUNK_PAD) continue;
        for (const t of vis._tallStatics) roofScope.push(t);
      }
      const dynamicRoofScope = this._dynamicTallsInBox(roofMinX, roofMinY, roofMaxX, roofMaxY);
      for (const t of dynamicRoofScope) roofScope.push(t);
      const roofBoundsScratch = this._roofBoundsScratch ?? (this._roofBoundsScratch = createTallStructureScratch());
      roofStructureBounds = tallStructureBoundsForPlayer(roofScope, playerX, playerY, playerZ, roofBoundsScratch);
      const maxDrawZ = this._computeMaxDrawZ(playerX, playerY, playerZ);
      const covered = maxDrawZ !== Infinity || !!roofStructureBounds;
      const indoors = roofHideOn && covered;
      world.playerIndoors = covered;
      this._updateRoofDebugOverlay(roofStructureBounds, playerX, playerY, playerZ);
      for (const vis of this.visuals.values()) {
        if (!vis.ready) continue;
        const tallFar = Math.abs(vis.cx - playerCx) > TALL_CHUNK_PAD
                     || Math.abs(vis.cy - playerCy) > TALL_CHUNK_PAD;
        if (tallFar) {
          if (vis._tallDirty) {
            for (const t of vis._tallStatics) {
              if (!t.sprite.visible) t.sprite.visible = true;
              if (t.sprite.alpha !== 1) t.sprite.alpha = 1;
            }
            vis._tallDirty = false;
          }
          // Foliage block below still needs to run for its own reset
          // path; jump straight to it without doing the tall-static work.
        } else {
          vis._tallDirty = true;
          for (const t of vis._tallStatics) {
            // ONLY roofs autohide when the player goes indoors — the
            // canonical CUO "Hide statics under roof" behaviour. Walls
            // and other tall props stay SOLID at full opacity. Static
            // map roofs now share the same footprint gate as dynamic
            // multis, so a neighbouring roof component is not removed
            // unless the avatar stands inside that component bounds.
            const hide = shouldHideTallEntry(t, playerX, playerY, indoors, roofCut, maxDrawZ, roofStructureBounds);
            if (t.sprite.visible === hide) t.sprite.visible = !hide;
            if (!hide) {
              const alpha = _cotAlphaFor(t.x, t.y, playerX, playerY, cotRadius, cotType);
              if (t.sprite.alpha !== alpha) t.sprite.alpha = alpha;
            }
          }
        } /* end !tallFar tall-static block */
        // Circle of Transparency is explicit now: by default foliage is
        // solid (as requested in the roof pass), but when the user
        // enables CoT we fade foliage/tall props inside the configured
        // radius like ClassicUO.
        if (vis._foliageDirty || cotType) {
          for (const f of vis._foliage) {
            const alpha = _cotAlphaFor(f.x, f.y, playerX, playerY, cotRadius, cotType);
            if (f.sprite.alpha !== alpha) f.sprite.alpha = alpha;
          }
          vis._foliageDirty = false;
        }
      }

      // Dynamic-tall pass: identical roof-cut / circle-of-transparency
      // logic as the chunk loop above, but driven by `_dynamicTalls`
      // (placemulti houses + dynamic walls / roofs). Only re-touch the
      // current roof scope plus serials that were hidden on an earlier
      // pass; walking out of a house resets those, while distant multis
      // no longer cost a full-map scan every frame.
      const dynamicSerials = this._dynamicSerialScratch ?? (this._dynamicSerialScratch = new Set());
      dynamicSerials.clear();
      for (const serial of this._dynamicTallDirtySerials) dynamicSerials.add(serial);
      for (const t of this._dynamicTallsInBox(roofMinX, roofMinY, roofMaxX, roofMaxY)) {
        const owner = t.ownerSerial >>> 0;
        if (owner) dynamicSerials.add(owner);
      }
      const stillDirty = this._dynamicStillDirtyScratch ?? (this._dynamicStillDirtyScratch = new Set());
      stillDirty.clear();
      for (const serial of dynamicSerials) {
        const entries = this._dynamicTalls.get(serial >>> 0);
        if (!entries) continue;
        let needsReset = false;
        for (const t of entries) {
          if (!t.sprite || t.sprite.destroyed) continue;
          const hide = shouldHideTallEntry(t, playerX, playerY, indoors, roofCut, maxDrawZ, roofStructureBounds);
          if (t.sprite.visible === hide) t.sprite.visible = !hide;
          if (!hide) {
            const alpha = _cotAlphaFor(t.x, t.y, playerX, playerY, cotRadius, cotType);
            if (t.sprite.alpha !== alpha) t.sprite.alpha = alpha;
          }
          if (hide || t.sprite.alpha !== 1) needsReset = true;
        }
        if (needsReset) stillDirty.add(serial >>> 0);
      }
      this._dynamicTallDirtySerials.clear();
      for (const serial of stillDirty) this._dynamicTallDirtySerials.add(serial);
    }

    let visibleStamp = ((this._visibleChunkStamp + 1) >>> 0);
    if (visibleStamp === 0) {
      visibleStamp = 1;
      for (const vis of this.visuals.values()) vis._visibleStamp = 0;
    }
    this._visibleChunkStamp = visibleStamp;
    const visibleChunkKeys = this._visibleChunkKeys ?? (this._visibleChunkKeys = new Set());
    visibleChunkKeys.clear();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (cx < 0 || cy < 0) continue;
        if (cx >= assets.mapMeta.blocksWide)  continue;
        if (cy >= assets.mapMeta.blocksTall)  continue;
        if (!_chunkIntersectsViewport(cx, cy, centerX, centerY, viewport, 48)) continue;
        const key = (cy << 16) | (cx & 0xffff);
        let vis = this.visuals.get(key);
        if (!vis) {
          vis = new ChunkVisual(cx, cy, this.parent);
          this.visuals.set(key, vis);
          this._scheduleChunkPopulate(
            vis,
            Math.floor(centerX / CHUNK_SIZE),
            Math.floor(centerY / CHUNK_SIZE),
            0,
          );
        }
        vis._visibleStamp = visibleStamp;
        visibleChunkKeys.add(key);
      }
    }

    // Idle prefetch: pre-load one ring of chunks past the visible
    // radius so a quick pan in any direction doesn't pop. Browser-only
    // optimisation — we wrap in `requestIdleCallback` so it never
    // competes with the active frame budget. Pages cached in `_atlasPages`
    // and decoded JSON manifests sit in IDB so subsequent visits are
    // ~free; this just kicks the network fetch a little earlier.
    const ric = (typeof globalThis !== 'undefined' ? globalThis.requestIdleCallback : null);
    if (!this._prefetchScheduled && typeof ric === 'function') {
      this._prefetchScheduled = true;
      const prefetchGeneration = this._facetGeneration;
      const px0 = cx0 - 1, py0 = cy0 - 1;
      const px1 = cx1 + 1, py1 = cy1 + 1;
      ric(() => {
        this._prefetchScheduled = false;
        if (prefetchGeneration !== this._facetGeneration) return;
        for (let cy = py0; cy <= py1; cy++) {
          for (let cx = px0; cx <= px1; cx++) {
            if (cx < 0 || cy < 0) continue;
            if (cx >= assets.mapMeta.blocksWide) continue;
            if (cy >= assets.mapMeta.blocksTall) continue;
            if (!_chunkIntersectsViewport(
              cx, cy, centerX, centerY, viewport, CHUNK_SIZE * TILE_HALF_W,
            )) continue;
            const key = (cy << 16) | (cx & 0xffff);
            if (this.visuals.has(key)) continue;
            const vis = new ChunkVisual(cx, cy, this.parent);
            this.visuals.set(key, vis);
            this._scheduleChunkPopulate(
              vis,
              Math.floor(centerX / CHUNK_SIZE),
              Math.floor(centerY / CHUNK_SIZE),
              2,
            );
          }
        }
      }, { timeout: 1000 });
    }

    // Evict chunks far from the camera. Chunks just outside the live
    // radius enter an "idle" state; if they stay idle for IDLE_TIMEOUT_MS
    // we destroy them. Re-entering the radius cancels the timer.
    const cxC = Math.floor(centerX / CHUNK_SIZE);
    const cyC = Math.floor(centerY / CHUNK_SIZE);
    const keepRadius = Math.ceil(tileRadius / CHUNK_SIZE) + this.loadPad;
    const IDLE_TIMEOUT_MS = 30_000;
    const nowMs = now;
    if (!this._chunkIdleSince) this._chunkIdleSince = new Map();

    for (const [key, vis] of this.visuals) {
      if (vis._visibleStamp === visibleStamp) {
        // Visible — clear any idle marker.
        if (this._chunkIdleSince.has(key)) this._chunkIdleSince.delete(key);
        continue;
      }
      const dx = Math.abs(vis.cx - cxC);
      const dy = Math.abs(vis.cy - cyC);
      if (dx > keepRadius || dy > keepRadius) {
        // Hard eviction — outside keep radius.
        vis.destroy();
        this.visuals.delete(key);
        this._chunkIdleSince.delete(key);
        this._chunkRevision = (this._chunkRevision + 1) >>> 0;
        continue;
      }
      // Inside keep radius but off-screen — start/check idle timer.
      const since = this._chunkIdleSince.get(key);
      if (!since) {
        this._chunkIdleSince.set(key, nowMs);
      } else if (nowMs - since > IDLE_TIMEOUT_MS) {
        vis.destroy();
        this.visuals.delete(key);
        this._chunkIdleSince.delete(key);
        this._chunkRevision = (this._chunkRevision + 1) >>> 0;
      }
    }
    this._enforceChunkResidency(cxC, cyC, visibleStamp, nowMs);
    this._updateChunkDebugOverlay(visibleStamp, nowMs);
  }

  _enforceChunkResidency(centerCx, centerCy, visibleStamp, nowMs) {
    const soft = Math.max(32, clientRuntimeProfile.chunkSoftLimit | 0);
    const hard = Math.max(soft, clientRuntimeProfile.chunkHardLimit | 0);
    const candidates = [];
    for (const [key, vis] of this.visuals) {
      if (vis._visibleStamp === visibleStamp) continue;
      const distance = Math.max(Math.abs(vis.cx - centerCx), Math.abs(vis.cy - centerCy));
      const idleSince = this._chunkIdleSince?.get?.(key) || nowMs;
      if (nowMs - idleSince > 15_000 && !vis._staleAlarmed) {
        vis._staleAlarmed = true;
        this._staleChunkAlarms = (this._staleChunkAlarms | 0) + 1;
        bus.emit('diagnostics:stale-chunk', { cx: vis.cx, cy: vis.cy, idleMs: nowMs - idleSince });
      }
      candidates.push({ key, vis, distance, idleSince });
    }
    if (this.visuals.size <= soft) return;
    candidates.sort((a, b) => (b.distance - a.distance) || (a.idleSince - b.idleSince));
    const target = this.visuals.size > hard ? soft : Math.max(soft, this.visuals.size - 4);
    for (const row of candidates) {
      if (this.visuals.size <= target) break;
      row.vis.destroy();
      this.visuals.delete(row.key);
      this._chunkIdleSince?.delete?.(row.key);
      this._chunkRevision = (this._chunkRevision + 1) >>> 0;
    }
    if (this._chunkPopulateQueue.length) {
      this._chunkPopulateQueue = this._chunkPopulateQueue.filter((vis) => !vis._destroyed);
    }
  }

  _updateChunkDebugOverlay(visibleStamp, nowMs) {
    const borders = profileManager?.get?.('debug.chunkOverlay') === true;
    const heatmap = profileManager?.get?.('debug.chunkHeatmap') === true;
    const depth = profileManager?.get?.('debug.zDepthOverlay') === true && this._debugTile;
    const overlay = this._chunkDebugOverlay;
    if (!borders && !heatmap && !depth) {
      if (overlay && overlay.visible) { overlay.clear(); overlay.visible = false; }
      if (this._zDepthDebugLabel) this._zDepthDebugLabel.visible = false;
      return;
    }
    if (nowMs - (this._lastChunkDebugPaintAt || 0) < 180
        && this._lastChunkDebugRevision === this._chunkRevision) return;
    this._lastChunkDebugPaintAt = nowMs;
    this._lastChunkDebugRevision = this._chunkRevision;
    overlay.visible = true;
    overlay.clear();
    for (const vis of this.visuals.values()) {
      const x = vis.cx * CHUNK_SIZE; const y = vis.cy * CHUNK_SIZE;
      const points = [
        worldToScreenX(x, y), worldToScreenY(x, y, 0),
        worldToScreenX(x + CHUNK_SIZE, y), worldToScreenY(x + CHUNK_SIZE, y, 0),
        worldToScreenX(x + CHUNK_SIZE, y + CHUNK_SIZE), worldToScreenY(x + CHUNK_SIZE, y + CHUNK_SIZE, 0),
        worldToScreenX(x, y + CHUNK_SIZE), worldToScreenY(x, y + CHUNK_SIZE, 0),
      ];
      const ms = Math.max(0, Number(vis._populateMs) || 0);
      const heat = Math.min(1, ms / 40);
      if (heatmap && ms) overlay.poly(points, true).fill({
        color: heat > 0.66 ? 0xff3030 : heat > 0.33 ? 0xffb030 : 0x35d06f,
        alpha: 0.08 + heat * 0.18,
      });
      if (borders) {
        const color = vis._populateError ? 0xff3030 : vis.ready ? 0x35d06f
          : vis._visibleStamp === visibleStamp ? 0xffb030 : 0x4aa3ff;
        overlay.poly(points, true).stroke({ width: 1, color, alpha: 0.78 });
      }
    }
    if (this._zDepthDebugLabel) {
      this._zDepthDebugLabel.visible = !!depth;
      if (depth) {
        const { x, y } = this._debugTile;
        const ordered = this.parent.children
          .filter((child) => child !== overlay && child !== this._zDepthDebugLabel
            && child._worldX === x && child._worldY === y)
          .sort((a, b) => _zIndexOf(a) - _zIndexOf(b));
        this._zDepthDebugLabel.text = ordered.length
          ? ordered.slice(0, 12).map((child, index) => `${index + 1}. ${child._uoKind || child.constructor?.name || 'object'} z=${_zIndexOf(child)}`).join('\n')
          : `tile ${x},${y}: no mounted entries`;
        this._zDepthDebugLabel.position.set(worldToScreenX(x, y) + 26, worldToScreenY(x, y, 0) - 24);
      }
    }
  }

  /** TP-time hard chunk eviction. Same logic as the per-frame keepRadius
   *  walk but skips the idle-timer + runs immediately. Called when
   *  update() detects the player centre jumped beyond a normal step. */
  _evictDistantChunksHard(centerX, centerY, tileRadius) {
    const cxC = Math.floor(centerX / CHUNK_SIZE);
    const cyC = Math.floor(centerY / CHUNK_SIZE);
    const keepRadius = Math.ceil(tileRadius / CHUNK_SIZE) + this.loadPad;
    for (const [key, vis] of this.visuals) {
      const dx = Math.abs(vis.cx - cxC);
      const dy = Math.abs(vis.cy - cyC);
      if (dx <= keepRadius && dy <= keepRadius) continue;
      vis.destroy();
      this.visuals.delete(key);
      if (this._chunkIdleSince) this._chunkIdleSince.delete(key);
      this._chunkRevision = (this._chunkRevision + 1) >>> 0;
    }
  }

  /** Drop world-item SPRITES whose tile is too far from the player so
   *  the renderer doesn't carry visuals for unreachable chunks. DO NOT
   *  delete `world.items` entries — the server's per-client
   *  `state._visibleItems` Set caches which serials it has already
   *  pushed and won't re-send unless the cache says otherwise. If we
   *  remove the shared world entry locally, the server still thinks
   *  the client has it; walking back into range produces no
   *  `worldItemSA` re-broadcast and the item is GONE FOREVER from the
   *  client view until reconnect. User report 2026-05-19 "jak odejdę
   *  od banku britani to nie ma drzwi znaków etc tak jakby się to nie
   *  doładowywało" — items past the initial chunk never reappeared
   *  because this prune was clobbering them every camera-pan jump. */
  _pruneDistantItems(centerX, centerY) {
    const FAR = 30;
    for (const [serial, vis] of this.items) {
      const it = world.items?.get?.(serial);
      if (!it) { vis.destroy(); this.items.delete(serial); continue; }
      if (it.parent) continue;          // contained / equipped — leave alone
      if (Math.abs(it.x - centerX) <= FAR && Math.abs(it.y - centerY) <= FAR) continue;
      // Out-of-range ground item: drop the local sprite + door-index
      // entry, but PRESERVE the `world.items` entry. The server's
      // `removeEntity` (0x1D) is the canonical evictor — when the
      // player truly leaves perception of an item the server will
      // send it. Until then the entry stays so a future
      // `streamVisibilityDelta` re-send (after walk-back-in-range)
      // can re-mount the sprite from the same entry.
      doorTileIndex.unregister(serial);
      vis.destroy();
      this.items.delete(serial);
    }
  }

  destroy() {
    this._clearChunkPopulateQueue();
    for (const u of this._unsubs ?? []) u();
    if (this._unsubs) this._unsubs.length = 0;
    for (const vis of this.visuals.values()) vis.destroy();
    this.visuals.clear();
    for (const it of this.items.values()) it.destroy();
    this.items.clear();
    doorTileIndex.clear();
    this._animatedItems.length = 0;
    this._mountQueue.length = 0;
    this._mountQueueHead = 0;
    if (this._mountRaf) {
      cancelAnimationFrame(this._mountRaf);
      this._mountRaf = 0;
    }
    if (this._invalidateRaf) {
      cancelAnimationFrame(this._invalidateRaf);
      this._invalidateRaf = 0;
    }
    if (this._pendingInvalidate) this._pendingInvalidate.clear();
    this._dynamicTalls.clear();
    this._dynamicTallsByTile.clear();
    this._dynamicTallDirtySerials.clear();
    this._dynamicTallsRevision = (this._dynamicTallsRevision + 1) >>> 0;
    this._chunkRevision = (this._chunkRevision + 1) >>> 0;
    this._clearHousePreview();
    this._clearCotDebugOverlay();
    this._clearRoofDebugOverlay();
    try { this._chunkDebugOverlay?.destroy?.(); } catch { /* ignore */ }
    try { this._zDepthDebugLabel?.destroy?.(); } catch { /* ignore */ }
  }
}
