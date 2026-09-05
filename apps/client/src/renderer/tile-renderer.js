// Land + statics renderer with real UO art.
//
// Each chunk (8×8 tiles) is mounted as one Pixi Container that holds:
//   - 64 land sprites (Pixi Sprite, 44×44 from land-atlas)
//   - the chunk's static sprites (variable count per chunk)
// The container's children are sorted on (Y + Z) to match ClassicUO's
// back-to-front draw order.

import { Graphics, Text } from 'pixi.js';
import { CHUNK_SIZE } from '../world/map.js';
import { TILE_W, TILE_H, TILE_HALF_W, TILE_HALF_H, worldToScreenX, worldToScreenY,
         depthKey, LAYER_ITEM } from './iso.js';
import { assets } from '../assets/asset-manager.js';
import { world } from '../world/world.js';
import { bus } from '../core/event-bus.js';
import { applyHueTo } from './hue-filter.js';
import {
  acquireSprite, landMeshPool, releaseSprite, spriteLeaseValid,
} from './sprite-pool.js';
import { profile as profileManager } from '../managers/profile-manager.js';
import { lightPoints, staticLightSpec } from './light-points.js';
import { houseCustomization, HouseCustomState } from '../managers/house-customization-manager.js';
import { houseManager } from '../managers/house-manager.js';
import { isNoDrawStatic, staticEntry } from '../shared/tiledata.js';
import { displayItemIdForAmount } from '../shared/stack-graphics.js';
import { clientPerformanceGovernor, clientRuntimeProfile, FrameTaskScheduler } from '../shared/runtime-governor.js';
import { MobileAnimation, Action } from './mobile-animation.js';
import { corpseManager } from '../managers/corpse-manager.js';
import {
  boundsContains as _boundsContains, createTallStructureScratch,
  shouldHideTallEntry, tallTileKey as _tallTileKey,
  tallStaticBounds, tallStructureBoundsForPlayer,
} from './tall-structure.js';
export { assignTallStructureBounds, shouldHideTallEntry, tallStaticBounds, tallStructureBoundsForPlayer } from './tall-structure.js';
import {
  CHUNK_DIRECTION_VECTORS,
  ChunkVisual,
  EMPTY_ARRAY,
  FLAG_BACKGROUND,
  FLAG_BRIDGE,
  FLAG_FOLIAGE,
  FLAG_ROOF,
  FLAG_SURFACE,
  FLAG_TRANSLUCENT,
  FLAG_TRANSPARENT,
  FLAG_WALL,
  MAX_CHUNK_POPULATES,
  ROOF_DEBUG_LABEL_STYLE,
  STATIC_ANIM_TICK_MS,
  WorldItemSprite,
  _chunkIntersectsViewport,
  _chunkTransitionsTick,
  _cotAlphaFor,
  _profileStaticGraphic,
  _roofBoundsDebugId,
  _setNoColorTint,
  _shouldAnimateStaticGraphic,
  _zIndexOf,
  activeChunkReveals,
  activeChunkShimmers,
  doorTileIndex,
} from './chunk-visual.js';


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
    this._houseCollaborationOverlay = new Graphics();
    this._houseCollaborationOverlay.eventMode = 'none';
    this._houseCollaborationOverlay.zIndex = 0x7fff00;
    this.parent.addChild(this._houseCollaborationOverlay);
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
    this._houseDraftSprites = [];
    this._houseDraftGeneration = 0;
    this._customHouseSprites = new Map();
    this._customHouseGenerations = new Map();
    this._unsubs = [
      bus.on('item:placed',    (it) => this._enqueueMount(it)),
      bus.on('entity:removed', ({ serial }) => {
        this._removeItem(serial);
        this._clearCustomHouse(serial);
      }),
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
        // Application owns a private Pixi ticker. Driving transitions from
        // `Ticker.shared` left the shimmer frozen on some builds. Reuse the
        // scene's existing frame event: one O(loading chunks) pass, zero
        // extra RAF/timer loops, and an immediate no-op once both sets empty.
        if (activeChunkShimmers.size || activeChunkReveals.size) {
          _chunkTransitionsTick(Number(now) || performance.now());
        }
        if (this._streamFrameAt) {
          const frameMs = Math.max(1, Math.min(250, Number(now) - this._streamFrameAt));
          this._streamFrameEma = this._streamFrameEma * 0.9 + frameMs * 0.1;
          const background = globalThis.document?.hidden === true;
          const stressed = background || this._streamFrameEma > 24;
          const healthy = !background && this._streamFrameEma < 18;
          const qualityScale = clientPerformanceGovernor.qualityScale();
          const qualityPopulates = Math.max(1, Math.round(clientRuntimeProfile.chunkPopulates * qualityScale));
          const qualityMountBatch = Math.max(8, Math.round(clientRuntimeProfile.mountBatch * qualityScale));
          this._maxChunkPopulates = stressed ? 1 : healthy ? qualityPopulates : Math.min(2, qualityPopulates);
          this._mountBatchSize = stressed ? Math.min(10, qualityMountBatch) : healthy ? qualityMountBatch : Math.min(20, qualityMountBatch);
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
      bus.on('house:draft-changed', ({ tiles } = {}) => {
        this._setHouseDraft(tiles ?? []).catch(() => { /* optimistic preview only */ });
      }),
      bus.on('house:custom-start', ({ serial } = {}) => this._clearCustomHouse(serial)),
      bus.on('house:design', ({ serial, tiles } = {}) => {
        if (!serial || !Array.isArray(tiles)) return;
        if (houseCustomization.state !== HouseCustomState.Idle
            && houseCustomization.targetSerial === (serial >>> 0)) {
          this._clearCustomHouse(serial);
          return;
        }
        this._setCustomHouseDesign(serial, tiles).catch(() => { /* next revision retries */ });
      }),
      bus.on('house:collaboration', (snapshot) => this._drawHouseCollaborators(snapshot)),
    ];

    // Login streams nearby world items before GameScene finishes loading.
    // Those packets already populated `world.items`, but their `item:placed`
    // events were emitted while LoginScene was still active and therefore
    // before this renderer subscribed. Hydrate that authoritative snapshot
    // once here so houses, boats, doors and other stationary items are not
    // invisible until a later movement/resync happens to re-broadcast them.
    // The regular mount queue keeps the catch-up frame-budgeted, and any
    // newer `item:placed` event safely remounts the same serial in place.
    for (const item of world.items.values()) {
      if (!item || item.parent) continue;
      this._enqueueMount(item);
    }
    for (const house of houseManager.values()) {
      if (Array.isArray(house.tiles) && !house.editingPayload) {
        this._setCustomHouseDesign(house.serial, house.tiles).catch(() => {});
      }
    }
  }

  _drawHouseCollaborators(snapshot) {
    const overlay = this._houseCollaborationOverlay;
    if (!overlay || overlay.destroyed) return;
    overlay.clear();
    for (const participant of (snapshot?.participants ?? []).slice(0, 16)) {
      const cursor = participant?.cursor;
      if (!cursor || (participant.serial >>> 0) === (world.player?.serial >>> 0)) continue;
      const x = worldToScreenX(cursor.x, cursor.y);
      const y = worldToScreenY(cursor.x, cursor.y, cursor.z);
      overlay.moveTo(x - 9, y).lineTo(x + 9, y).moveTo(x, y - 9).lineTo(x, y + 9)
        .stroke({ width: 2, color: 0x70d7ff, alpha: 0.95 });
      overlay.circle(x, y, 5).stroke({ width: 1, color: 0xffffff, alpha: 0.9 });
    }
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

  /** Warm server-suggested chunks using the same frame-budgeted population
   * queue as local viewport prediction. Suggestions are hints only and are
   * bounded so a server cannot force an unbounded client allocation. */
  prefetchChunks(chunks, facet = assets.activeFacet) {
    if ((facet | 0) !== (assets.activeFacet | 0)) return 0;
    const centerCx = Math.floor((world.player?.x ?? 0) / CHUNK_SIZE);
    const centerCy = Math.floor((world.player?.y ?? 0) / CHUNK_SIZE);
    let scheduled = 0;
    for (const row of (Array.isArray(chunks) ? chunks : []).slice(0, 64)) {
      const cx = Number(row?.x) | 0;
      const cy = Number(row?.y) | 0;
      if (cx < 0 || cy < 0 || cx >= assets.mapMeta.blocksWide || cy >= assets.mapMeta.blocksTall) continue;
      if (Math.max(Math.abs(cx - centerCx), Math.abs(cy - centerCy)) > 8) continue;
      const key = (cy << 16) | (cx & 0xffff);
      if (this.visuals.has(key)) continue;
      const vis = new ChunkVisual(cx, cy, this.parent);
      this.visuals.set(key, vis);
      this._scheduleChunkPopulate(vis, centerCx, centerCy, 2 + Math.max(0, Number(row.priority) | 0));
      scheduled++;
    }
    return scheduled;
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
      // Priority is recomputed above, so queue order carries no meaning.
      // Swap-pop avoids shifting the rest of the visible-window array on
      // every completed chunk (noticeable during teleports/facet changes).
      const vis = this._chunkPopulateQueue[best];
      const last = this._chunkPopulateQueue.pop();
      if (best < this._chunkPopulateQueue.length) this._chunkPopulateQueue[best] = last;
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
    this._clearCustomHouses();
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
      if (idx >= 0) {
        list[idx] = list[list.length - 1];
        list.pop();
      }
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
    if (it.multiId != null) {
      // Render every tile of the multi at (it.x + dx, it.y + dy, it.z + dz).
      const tiles = assets.multiTiles(it.multiId);
      if (tiles) {
        const prepared = [];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const t of tiles) {
          if (!t.visible) continue;
          if (isNoDrawStatic(assets.tiledata, t.id)) continue;
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
      if (isNoDrawStatic(assets.tiledata, displayItemId)) return;
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
        // items missed entirely, leaving forges and street lamps dark at night.
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
    if (!itemId || isNoDrawStatic(assets.tiledata, itemId)) return null;
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
    // depth ordering in line with the static map instead of drawing floors over walls.
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
      this._animatedItems.push({
        sprite: sp,
        generation: sp._uoPoolGeneration >>> 0,
        baseId: itemId,
        x: wx | 0,
        y: wy | 0,
      });
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

  _clearHouseDraft() {
    this._houseDraftGeneration++;
    for (const sprite of this._houseDraftSprites) releaseSprite(sprite);
    this._houseDraftSprites.length = 0;
  }

  _clearCustomHouse(serial) {
    const key = Number(serial) >>> 0;
    if (!key) return;
    this._customHouseGenerations.set(key, (this._customHouseGenerations.get(key) ?? 0) + 1);
    for (const sprite of this._customHouseSprites.get(key) ?? []) releaseSprite(sprite);
    this._customHouseSprites.delete(key);
    this._deleteDynamicTalls((key | 0x80000000) >>> 0);
  }

  _clearCustomHouses() {
    for (const serial of [...this._customHouseSprites.keys()]) this._clearCustomHouse(serial);
    this._customHouseGenerations.clear();
  }

  async _setCustomHouseDesign(serial, tiles) {
    const key = Number(serial) >>> 0;
    const foundation = world.items.get(key);
    if (!key || !foundation) return;
    this._clearCustomHouse(key);
    const generation = this._customHouseGenerations.get(key) ?? 0;
    const sprites = [];
    this._customHouseSprites.set(key, sprites);
    const list = tiles.slice(0, 10_000);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const tile of list) {
      const x = (foundation.x | 0) + (tile.x | 0);
      const y = (foundation.y | 0) + (tile.y | 0);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const bounds = Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
    const tallList = [];
    for (let index = 0; index < list.length; index++) {
      const tile = list[index];
      const graphic = tile.graphic | 0;
      if (!graphic) continue;
      const texture = assets.staticTextureSync?.(graphic) ?? await assets.staticTexture(graphic);
      if ((this._customHouseGenerations.get(key) ?? 0) !== generation) return;
      if (!texture) continue;
      const x = (foundation.x | 0) + (tile.x | 0);
      const y = (foundation.y | 0) + (tile.y | 0);
      const z = (foundation.z | 0) + (tile.z | 0);
      const sprite = acquireSprite(texture);
      sprite.anchor.set(0.5, 1);
      sprite.eventMode = 'none';
      sprite._worldX = x;
      sprite._worldY = y;
      sprite.position.set(worldToScreenX(x, y), worldToScreenY(x, y, z) + TILE_HALF_H);
      sprite.zIndex = depthKey(x, y, z, LAYER_ITEM);
      this.parent.addChild(sprite);
      sprites.push(sprite);
      const tall = this._classifyTall(graphic, x, y, z, sprite, {
        sourceSerial: key, bounds,
      });
      if (tall) tallList.push(tall);
      if ((index & 63) === 63) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if ((this._customHouseGenerations.get(key) ?? 0) !== generation) return;
      }
    }
    if ((this._customHouseGenerations.get(key) ?? 0) === generation && tallList.length) {
      this._setDynamicTalls((key | 0x80000000) >>> 0, tallList);
    }
  }

  _updateCustomHouseRange(centerX, centerY) {
    const range = 32;
    for (const house of houseManager.values()) {
      const serial = house.serial >>> 0;
      const foundation = world.items.get(serial);
      const near = foundation
        && Math.abs((foundation.x | 0) - centerX) <= range
        && Math.abs((foundation.y | 0) - centerY) <= range;
      if (!near || house.editingPayload) {
        if (this._customHouseSprites.has(serial)) this._clearCustomHouse(serial);
        continue;
      }
      if (!this._customHouseSprites.has(serial) && Array.isArray(house.tiles)) {
        this._setCustomHouseDesign(serial, house.tiles).catch(() => {});
      }
    }
  }

  async _setHouseDraft(tiles) {
    this._clearHouseDraft();
    const generation = this._houseDraftGeneration;
    const list = tiles.slice(0, 10_000);
    for (let index = 0; index < list.length; index++) {
      const tile = list[index];
      const graphic = tile.graphic | 0;
      if (!graphic) continue;
      const texture = assets.staticTextureSync?.(graphic) ?? await assets.staticTexture(graphic);
      if (generation !== this._houseDraftGeneration) return;
      if (!texture) continue;
      const sprite = acquireSprite(texture);
      sprite.anchor.set(0.5, 1);
      sprite.eventMode = 'none';
      sprite.alpha = 0.78;
      sprite.tint = tile.kind === 'roof' ? 0xffd8a0 : 0xb0f0ff;
      sprite.position.set(
        worldToScreenX(tile.x | 0, tile.y | 0),
        worldToScreenY(tile.x | 0, tile.y | 0, tile.z | 0) + TILE_HALF_H,
      );
      sprite.zIndex = depthKey(tile.x | 0, tile.y | 0, (tile.z | 0) + 1, LAYER_ITEM) + 1;
      this.parent.addChild(sprite);
      this._houseDraftSprites.push(sprite);
      if ((index & 63) === 63) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
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
    // elevated z don't form a roof and must not be treated as one. A table at
    // z=5 previously set maxDrawZ=5, then
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
    this._updateCustomHouseRange(px, py);
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
          // A released pooled sprite is not destroyed. It may already be a
          // paperdoll layer or a completely different world tile, so retain
          // the entry only while its original ownership generation matches.
          if (!spriteLeaseValid(a.sprite, a.generation)) continue;
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
          const generation = a.generation;
          assets.staticTexture(id).then((tex) => {
            if (tex && a._pendingAnimId === id
                && spriteLeaseValid(a.sprite, generation)) {
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
   *  client view until reconnect. Items beyond the initial chunk never reappeared
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
    this._clearHouseDraft();
    this._clearCustomHouses();
    this._clearCotDebugOverlay();
    this._clearRoofDebugOverlay();
    try { this._chunkDebugOverlay?.destroy?.(); } catch { /* ignore */ }
    try { this._houseCollaborationOverlay?.destroy?.(); } catch { /* ignore */ }
    try { this._zDepthDebugLabel?.destroy?.(); } catch { /* ignore */ }
  }
}
