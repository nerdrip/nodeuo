import { Container, Sprite, Graphics, TextStyle } from 'pixi.js';
import { CHUNK_SIZE } from '../world/map.js';
import {
  TILE_W, TILE_HALF_W, TILE_HALF_H, Z_STEP, worldToScreenX, worldToScreenY,
  depthKey, LAYER_LAND, LAYER_STATIC,
} from './iso.js';
import { assets } from '../assets/asset-manager.js';
import { applyHueTo } from './hue-filter.js';
import {
  acquireLandMesh, acquireSprite, releaseLandMesh, releaseSprite,
} from './sprite-pool.js';
import { seasonManager } from '../managers/season-manager.js';
import { profile as profileManager } from '../managers/profile-manager.js';
import { lightPoints, staticLightSpec } from './light-points.js';
import { isNoDrawStatic, landEntry, staticEntry } from '../shared/tiledata.js';
import { FLAG_WET } from '../shared/tiledata-flags.js';
import { isAnimdataStaticGraphic } from './static-animation.js';
import { DoorTileIndex } from './door-tile-index.js';
import {
  assignTallStructureBounds, boundsContains as _boundsContains, createTallStructureScratch,
  tallTileKey as _tallTileKey, tallStaticBounds,
} from './tall-structure.js';

function releaseRenderObject(displayObject) {
  if (!displayObject) return;
  if (displayObject instanceof Sprite) releaseSprite(displayObject);
  else if (displayObject._uoLandMeshPool) releaseLandMesh(displayObject);
  else { try { displayObject.destroy(); } catch { /* ignore */ } }
}

export const doorTileIndex = new DoorTileIndex({
  resolveDoorPiece: (itemId) => assets.doorPiece?.(itemId),
  chunkSize: CHUNK_SIZE,
});
export const EMPTY_ARRAY = Object.freeze([]);
export const STATIC_ANIM_TICK_MS = 50;
export const MAX_ADD_CHILD_BATCH = 256;
export const MAX_CHUNK_POPULATES = 3;
export const CHUNK_REVEAL_MS = 360;
export const CHUNK_REVEAL_STAGGER_MS = 18;
// Native texmaps are deliberately different, coarse colour fields intended
// for tall terrain.  On ordinary 1-8 Z rolling ground they form conspicuous
// blue/grey strips between the much richer art.mul grass diamonds.  Preserve
// the land-art look on gentle slopes; authored cliffs still use texmaps so a
// 20-35 Z face never exposes the scene background.
export const GENTLE_ART_SLOPE_DELTA = 8;
// A four-corner quad has a visible hard diagonal on saddle-shaped terrain.
// A 4x4 grid is still tiny (25 vertices) but approximates the bilinear UO
// height field closely enough that hills no longer read as folded cardboard.
export const LAND_MESH_SUBDIVISIONS = 4;
export const FOLIAGE_STUMP_GRAPHIC = 0x0CCB;
export const FIELD_GRAPHIC_MIN = 0x398C;
export const FIELD_GRAPHIC_MAX = 0x399F;
export const FLAG_BACKGROUND = 0x00000001;
export const FLAG_TRANSPARENT = 0x00000004;
export const FLAG_TRANSLUCENT = 0x00000008;
export const FLAG_WALL = 0x00000010;
export const FLAG_SURFACE = 0x00000200;
export const FLAG_BRIDGE = 0x00000400;
export const FLAG_FOLIAGE = 0x00020000;
export const FLAG_ROOF = 0x10000000;
export const ROOF_DEBUG_LABEL_STYLE = new TextStyle({
  fill: 0xffd36a,
  fontSize: 12,
  fontFamily: 'Consolas, monospace',
  stroke: { color: 0x000000, width: 3 },
});

// One shared ticker drives every unresolved chunk and terrain reveal. A
// listener per chunk becomes surprisingly expensive during teleports, while
// this remains one O(visible-loading) pass and detaches when streaming ends.
export const activeChunkShimmers = new Set();
export const activeChunkReveals = new Set();

export function _chunkTransitionsTick(frameNow = performance.now()) {
  const now = Number(frameNow) || performance.now();
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
      // Streaming must never alter authored land colours.  Earlier builds
      // faded from a warm tint which made random freshly loaded tiles look
      // brighter than their neighbours.  Alpha alone is enough to reveal a
      // chunk without changing the palette.
      if (Number.isFinite(row.finalTint) && 'tint' in row.sprite) row.sprite.tint = row.finalTint;
      if (p < 1) complete = false;
    }
    if (complete) {
      activeChunkReveals.delete(entry);
      entry.done?.();
    }
  }
}

export function _reducedMotionRequested() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    || globalThis.localStorage?.getItem?.('uo.reduced-motion') === '1';
}

export const CHUNK_DIRECTION_VECTORS = Object.freeze([
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
]);

/** Fast conservative screen intersection for an 8×8 isometric block.
 * `tileRadius` gives a square in world coordinates and consequently queues
 * roughly twice as many chunks as the rectangular viewport can show. This
 * projection test keeps an elevation/tall-art margin while discarding those
 * invisible corner chunks before they compete for range/atlas requests. */
export function _chunkIntersectsViewport(cx, cy, centerX, centerY, viewport, padPx = 0) {
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

export function _isFieldGraphic(id) {
  const g = id | 0;
  return g >= FIELD_GRAPHIC_MIN && g <= FIELD_GRAPHIC_MAX;
}

export function _isFoliageFlags(flags) {
  return ((flags | 0) & 0x40) !== 0 || ((flags | 0) & FLAG_FOLIAGE) !== 0;
}

export function _fieldMode() {
  return String(profileManager?.get?.('ui.fieldsType') ?? 'classic').toLowerCase();
}

export function _shouldAnimateStaticGraphic(id) {
  if (_isFieldGraphic(id) && _fieldMode() === 'static') return false;
  return profileManager?.get?.('debug.skipAnimData') !== true
    && isAnimdataStaticGraphic(assets.tiledata, assets.animdata, id);
}

export function _profileStaticGraphic(id, flags) {
  const raw = id | 0;
  if (isNoDrawStatic(assets.tiledata, raw)) return 0;
  if (profileManager?.get?.('ui.hideVegetation') === true && _isFoliageFlags(flags)) return 0;
  if (profileManager?.get?.('ui.treeToStumps') === true && _isFoliageFlags(flags)) {
    const seasonal = seasonManager.remapStatic(raw);
    return seasonal !== raw ? seasonal : FOLIAGE_STUMP_GRAPHIC;
  }
  const seasonal = seasonManager.remapStatic(raw);
  return isNoDrawStatic(assets.tiledata, seasonal) ? 0 : seasonal;
}

export function _cotAlphaFor(x, y, playerX, playerY, radius, type) {
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

export function _roofBoundsDebugId(bounds) {
  if (!bounds) return 'none';
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (bounds.x0 | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (bounds.y0 | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (bounds.x1 | 0), 16777619) >>> 0;
  h = Math.imul(h ^ (bounds.y1 | 0), 16777619) >>> 0;
  return h.toString(16).slice(-6).toUpperCase();
}

export function _setNoColorTint(sp, on) {
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

export function _zIndexOf(displayObject) {
  const z = displayObject?.zIndex;
  return Number.isFinite(z) ? z : 0;
}

export class ChunkVisual {
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
          .fill({ color: 0x756c5d, alpha: 1 });
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
      if ('tint' in row.sprite) row.sprite.tint = row.finalTint;
    }
    this._landReveal = entry;
    activeChunkReveals.add(entry);
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
        if (isNoDrawStatic(assets.tiledata, it.id)) continue;
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
    const landInfo = landEntry(assets.tiledata, id);
    const texId = landInfo?.texId | 0;
    const hasTexmap = texId > 0 && !!assets.texmapAtlas?.tiles?.[texId];
    // ClassicUO stretches every non-flat land tile with a valid texmap,
    // including the authored 25–35 Z escarpments around Trinsic. Flattening
    // those transitions leaves the lower water and upper bank disconnected,
    // exposing the blue scene background as large coastline holes.
    const cornerDelta = Math.max(zTop, zRight, zLeft, zBottom)
      - Math.min(zTop, zRight, zLeft, zBottom);
    // A valid texmap owns the complete four-corner surface even at a steep
    // coast/cliff transition. Flattening the tile above an arbitrary Z cap
    // disconnects the upper sand bank from the water and leaves the exact
    // row of floating diamonds visible around Britain (1516,1631). The
    // subdivided mesh below keeps steep surfaces stable without changing the
    // authored corner heights.
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
      // For normal hills use the same art.mul diamond as neighbouring flat
      // land, mapped into square slope coordinates.  This is an exact
      // inverse-diamond UV transform: on a flat quad it reproduces the Sprite
      // pixel-for-pixel, while on a slope it follows the height field without
      // the unrelated cyan/noisy texmap band visible around Britain farms.
      // Wet terrain stays on texmaps: transparent shore/water diamonds can
      // otherwise open pinholes along their alpha edge.
      const gentleArt = cornerDelta <= GENTLE_ART_SLOPE_DELTA
        && ((landInfo?.flags ?? 0) & FLAG_WET) === 0;
      if (gentleArt) {
        const artTex = assets.landTextureSync?.(id) ?? await assets.landTexture(id);
        if (artTex) {
          return makeStretchedLandArt(artTex, centerX, centerY, wx, wy, avgZ,
                                      zTop, zRight, zLeft, zBottom);
        }
      }
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
        // Preserve authored-delta diagnostics even when an abrupt cliff is
        // intentionally rendered as flat land art. Runtime QA can still
        // identify/measure the source tile without forcing unsafe geometry.
        sp._uoLandX = wx | 0;
        sp._uoLandY = wy | 0;
        sp._uoLandCornerDelta = cornerDelta;
        sp._uoLandTextureMode = 'flat-art';
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
export function makeStretchedTexmap(tex, centerX, centerY, wx, wy, depthZ,
                             zTop, zRight, zLeft, zBottom) {
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
  const meshData = buildSmoothLandMesh(
    zTop, zRight, zLeft, zBottom,
    (u, v) => [
      insetU + u * (1 - 2 * insetU),
      insetV + v * (1 - 2 * insetV),
    ],
  );
  const { vertices, uvs, indices } = meshData;
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
  mesh._uoLandTextureMode = 'texmap';
  mesh._uoLandCornerDelta = Math.max(zTop, zRight, zLeft, zBottom)
    - Math.min(zTop, zRight, zLeft, zBottom);
  return mesh;
}

/** Map an art.mul land diamond onto a gentle slope.  Parameter-space corners
 * are top/right/left/bottom; the UV transform below maps them to the matching
 * midpoints of the 44x44 diamond instead of sampling its transparent square
 * corners. */
export function makeStretchedLandArt(tex, centerX, centerY, wx, wy, depthZ,
                              zTop, zRight, zLeft, zBottom) {
  const tw = tex.frame?.width ?? tex.width ?? TILE_W;
  const th = tex.frame?.height ?? tex.height ?? TILE_W;
  const insetU = 0.5 / Math.max(1, tw);
  const insetV = 0.5 / Math.max(1, th);
  const loU = insetU, hiU = 1 - insetU;
  const loV = insetV, hiV = 1 - insetV;
  const meshData = buildSmoothLandMesh(
    zTop, zRight, zLeft, zBottom,
    (u, v) => {
      // Inverse isometric diamond: square (u,v) -> art-diamond (x,y).
      const artU = 0.5 + 0.5 * u - 0.5 * v;
      const artV = 0.5 * u + 0.5 * v;
      return [loU + artU * (hiU - loU), loV + artV * (hiV - loV)];
    },
  );
  const mesh = acquireLandMesh(tex, meshData.vertices, meshData.uvs, meshData.indices);
  initialiseLandMesh(mesh, centerX, centerY, wx, wy, depthZ,
                     zTop, zRight, zLeft, zBottom, 'art');
  return mesh;
}

/** Build a small bilinear grid for a land tile.  UO stores four shared corner
 * heights.  Two giant triangles expose their internal fold; subdividing the
 * same field changes no authored corner and adds no fake elevation, it only
 * removes the visible diagonal. */
export function buildSmoothLandMesh(zTop, zRight, zLeft, zBottom, uvAt) {
  const n = LAND_MESH_SUBDIVISIONS;
  const side = n + 1;
  const vertices = new Float32Array(side * side * 2);
  const uvs = new Float32Array(side * side * 2);
  let p = 0;
  for (let row = 0; row <= n; row++) {
    const v = row / n;
    for (let col = 0; col <= n; col++) {
      const u = col / n;
      const topEdge = zTop + (zRight - zTop) * u;
      const bottomEdge = zLeft + (zBottom - zLeft) * u;
      const z = topEdge + (bottomEdge - topEdge) * v;
      vertices[p] = TILE_HALF_W * (1 + u - v);
      vertices[p + 1] = TILE_HALF_H * (u + v) - z * Z_STEP;
      const uv = uvAt(u, v);
      uvs[p] = uv[0];
      uvs[p + 1] = uv[1];
      p += 2;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  // Match CUO's AverageZ decision: triangulate through the less severe
  // opposing-corner pair, avoiding a pronounced ridge on saddle tiles.
  const diagonalTopBottom = Math.abs(zTop - zBottom) <= Math.abs(zLeft - zRight);
  let q = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const a = row * side + col;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      if (diagonalTopBottom) {
        indices[q++] = a; indices[q++] = b; indices[q++] = d;
        indices[q++] = a; indices[q++] = d; indices[q++] = c;
      } else {
        indices[q++] = a; indices[q++] = b; indices[q++] = c;
        indices[q++] = b; indices[q++] = d; indices[q++] = c;
      }
    }
  }
  return { vertices, uvs, indices };
}

export function initialiseLandMesh(mesh, centerX, centerY, wx, wy, depthZ,
                            zTop, zRight, zLeft, zBottom, textureMode) {
  mesh.autoUpdate = false;
  mesh.onRender = null;
  mesh.position.set(centerX - TILE_HALF_W, centerY - TILE_HALF_H);
  mesh.zIndex = depthKey(wx, wy, depthZ, LAYER_LAND);
  mesh._uoLandX = wx | 0;
  mesh._uoLandY = wy | 0;
  mesh._worldX = wx | 0;
  mesh._worldY = wy | 0;
  mesh._worldZ = depthZ | 0;
  mesh._uoKind = 'land-mesh';
  mesh._uoLandTextureMode = textureMode;
  mesh._uoLandCornerDelta = Math.max(zTop, zRight, zLeft, zBottom)
    - Math.min(zTop, zRight, zLeft, zBottom);
}

/** Hash a land id to a stable RGB colour. id=0 used to be black which
 *  produced visible diagonal gaps between chunks; we map it to ocean
 *  blue instead. */
export function landIdFallbackColor(id) {
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
export class WorldItemSprite {
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
