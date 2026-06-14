// WorldmapGump — full-screen scrollable overhead map. Mirrors ClassicUO's
// Game/UI/Gumps/WorldMap/WorldMapGump.cs at MVP scope.
//
// We render the entire facet 0 grid as a CPU canvas (1 px per tile) on
// first open and reuse it. The player position is drawn as an overlay.
// Pan with click-drag, zoom with the mouse wheel.

import { Texture, Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { world } from '../../world/world.js';
import { assets } from '../../assets/asset-manager.js';
import { profile } from '../../managers/profile-manager.js';
import { Label } from '../controls/label.js';
import { Combobox } from '../controls/combobox.js';
import { Button, ButtonAction } from '../controls/button.js';
import { worldMapEntities } from '../../managers/world-map-entity-manager.js';
import { packedLandRadarColor } from '../../shared/radar-color.js';
import { acquireSprite, releaseSprite } from '../../renderer/sprite-pool.js';
import { bus } from '../../core/event-bus.js';

const VIEWPORT_W = 600;
const VIEWPORT_H = 400;
const WM_PROFILE_KEYS = Object.freeze({
  showCoordinates: 'worldmap.showCoordinates',
  showParty: 'worldmap.showParty',
  showGuild: 'worldmap.showGuild',
  showMarkers: 'worldmap.userMarkers',
  showGrid: 'worldmap.showGridIfZoomed',
  markerSize: 'worldmap.markerSize',
  showMobiles: 'ui.worldMapShowMobiles',
});

export class WorldmapGump extends WindowGump {
  constructor() {
    super({
      title: 'World Map', width: VIEWPORT_W + 20, height: VIEWPORT_H + 38,
      x: 80, y: 60,
      // Native UO gump card art behind the window — id 0x1391 is the
      // ServUO MapGump frame (CUO uses 0x139D for the parchment look,
      // but 0x1391 is more universal across server expansions).
      //
      // CRITICAL: 0x1391 is a SINGLE-sprite map-frame, not a 9-patch.
      // Without `singleSprite: true` the parent WindowGump fed it
      // through ResizePic which sliced the lone texture into corners +
      // edges + center as if it were a stretchable 9-patch — the title
      // bar at the top showed up as black wavy garbage (user report
      // 2026-05-17 — "gump mapy do poprawy: gora pasek do bani").
      backgroundId: 0x1391,
      singleSprite: true,
    });
    // Decorative parchment border — drawn over the canvas so the user
    // can still pan/zoom. Without this the map sat on a flat dark
    // panel that didn't match CUO's parchment+brass look.
    this._parchmentFrame = new Graphics();
    this._parchmentFrame
      .roundRect(8, 26, VIEWPORT_W + 4, VIEWPORT_H + 4, 4)
      .stroke({ width: 2, color: 0x6e5520, alpha: 0.85 })
      .roundRect(9, 27, VIEWPORT_W + 2, VIEWPORT_H + 2, 3)
      .stroke({ width: 1, color: 0xc8a060, alpha: 0.6 });
    this.node.addChild(this._parchmentFrame);

    // Prefer OffscreenCanvas where available (Chrome / Edge / Safari):
    // mutating its bitmap doesn't reflow the layout tree and lets Pixi
    // pull the texture without a synchronous DOM round-trip. Falls
    // back to a regular <canvas> when the platform lacks it.
    if (typeof OffscreenCanvas !== 'undefined') {
      this._canvas = new OffscreenCanvas(VIEWPORT_W, VIEWPORT_H);
      this._isOffscreen = true;
    } else {
      this._canvas = document.createElement('canvas');
      this._canvas.width = VIEWPORT_W;
      this._canvas.height = VIEWPORT_H;
      this._isOffscreen = false;
    }
    this._ctx = this._canvas.getContext('2d');
    // Pre-allocated typed-array view of the framebuffer. Writing
    // Uint32 colours is one store per pixel vs four for ImageData, and
    // we never need to recreate the buffer because `_render` paints
    // every pixel each pass. Saves ~3× CPU on the inner loop.
    this._imgData = this._ctx.createImageData(VIEWPORT_W, VIEWPORT_H);
    this._pixelsU32 = new Uint32Array(this._imgData.data.buffer);
    this._tex = Texture.from(this._canvas);
    this._sprite = acquireSprite(this._tex);
    this._sprite.position.set(10, 28);
    this.node.addChild(this._sprite);

    this._playerDot = new Graphics().circle(0, 0, 3).fill({ color: 0xffe680 });
    this.node.addChild(this._playerDot);

    // Overlays for party / guild blips and user markers. Cleared and
    // re-painted each tick so we don't leak Graphics children.
    this._overlay = new Graphics();
    this.node.addChild(this._overlay);

    // Coordinate read-out at the bottom of the panel.
    this._coordLabel = new Label('(0, 0) z=1', { fontSize: 11, hue: 0xc0b890, stroke: false });
    this._coordLabel.setPosition(14, 28 + VIEWPORT_H + 4);
    this._coordLabel.acceptMouseInput = false;
    this.add(this._coordLabel);

    // Audit rev.9 P2 #6 — replace facet name label + dbl-click cycle
    // with a proper Combobox dropdown (matches CUO chrome). Plus a new
    // "Plot Route" toggle button that, when active, switches RMB from
    // marker-add to waypoint-append. The route is rendered as a yellow
    // polyline overlay; double-click "Plot" again to finalise.
    this._mapFacet = (assets.currentFacet ?? 0) | 0;
    // Combobox takes `values: string[]` not `items: [{id,label}]` —
    // the previous shape made the dropdown render empty (head text
    // = '' from `value || values[0] || ''` with values=[]) and the
    // popup had no rows, so the user saw a button that "didn't do
    // anything obvious". Map facet index ↔ label by array position.
    const FACET_NAMES = ['Felucca', 'Trammel', 'Ilshenar', 'Malas', 'Tokuno', 'TerMur'];
    this._facetCombo = new Combobox({
      width: 110,
      values: FACET_NAMES,
      value: FACET_NAMES[this._mapFacet] ?? FACET_NAMES[0],
      onChange: (label) => this._setFacet(FACET_NAMES.indexOf(label)),
    });
    this._facetCombo.setPosition(VIEWPORT_W - 120, 28 + VIEWPORT_H + 2);
    // Must use Control.add — bare `node.addChild` only attaches the Pixi
    // node and skips the Control children array, so UIManager.pickAt
    // never finds the combobox/button (clicks fell through to the gump
    // background and did nothing — user report 2026-05-17).
    this.add(this._facetCombo);
    // Plot-route toggle button (cycles `_plotMode`).
    this._plotMode = false;
    this._route = []; // { x, y } tile coords
    this._plotBtn = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 22, label: 'Plot Route', action: ButtonAction.Activate,
    });
    this._plotBtn.setPosition(VIEWPORT_W - 220, 28 + VIEWPORT_H + 2);
    this._plotBtn.onClick = () => this._togglePlot();
    this.add(this._plotBtn);

    /** centre of the visible window in *tile* coords */
    this._cx = world.player?.x ?? 1500;
    this._cy = world.player?.y ?? 1600;
    /** zoom — pixels per tile (>=1) */
    this._zoom = profile.get('worldmap.zoom') ?? 1;
    /** auto-pan: if true, recenter on player every tick */
    this._autoPan = profile.get('worldmap.autoPan') ?? false;
    /** Audit rev.9 P2 #6 — `_mapFacet` set above (Combobox-controlled). */

    this._dragging = false;
    this._lastDrag = { x: 0, y: 0 };
    this.acceptMouseInput = true;
    this.acceptMouseWheel = true;

    this._lastRedraw = 0;
    this._lastTerrainKey = '';
    this._lastOverlayKey = '';
    this._lastOverlayPaintAt = 0;
    this._visibleSerials = new Uint32Array(32);
    this._visibleSerialCount = 0;
    this._mobileClusterBuckets = new Map();
    this._markerClusterBuckets = new Map();
    this.worldMapStats = {
      mobilePins: 0,
      mobileClusters: 0,
      markerPins: 0,
      markerClusters: 0,
    };
    this._syncProfileFlags();
    this._profileSub = bus.on('profile:changed', ({ path } = {}) => {
      if (!path || path.startsWith('worldmap.') || path === WM_PROFILE_KEYS.showMobiles) {
        this._syncProfileFlags();
        this._coordText = '';
        this._lastOverlayPaintAt = 0;
      }
    });
    this._profileResetSub = bus.on('profile:reset', () => {
      this._syncProfileFlags();
      this._coordText = '';
      this._lastOverlayPaintAt = 0;
    });
    this._profileBoundSub = bus.on('profile:bound', () => {
      this._syncProfileFlags();
      this._coordText = '';
      this._lastOverlayPaintAt = 0;
    });
    // Audit #46 P3 — auto-enable WorldMapEntityManager polling while
    // the worldmap is open. Dynamic import so the gump file can stay
    // cycle-free (entity manager itself imports from the gump
    // metadata). Promise-fire-and-forget; if the import races slow we
    // simply enable late.
    import('../../managers/world-map-entity-manager.js').then((m) => {
      this._wm = m.worldMapEntities;
      this._prevEntityEnabled = this._wm?._enabled ?? false;
      this._wm?.setEnabled?.(true);
    }).catch(() => {});
    this._render(true);
    this._updatePlayerOverlay(true);
  }

  get type() { return 'worldmap'; }

  _syncProfileFlags() {
    this._showCoordinates = profile.get(WM_PROFILE_KEYS.showCoordinates) ?? true;
    this._showParty = profile.get(WM_PROFILE_KEYS.showParty) ?? true;
    this._showGuild = profile.get(WM_PROFILE_KEYS.showGuild) ?? false;
    this._showMarkers = profile.get(WM_PROFILE_KEYS.showMarkers) ?? true;
    this._showGrid = profile.get(WM_PROFILE_KEYS.showGrid) ?? true;
    this._showMobiles = profile.get(WM_PROFILE_KEYS.showMobiles) ?? true;
    this._markerSize = Math.max(4, Math.min(24, profile.get(WM_PROFILE_KEYS.markerSize) ?? 10));
  }

  dispose() {
    // Audit #46 P3 — restore WorldMapEntityManager poll state on close.
    try { this._wm?.setEnabled?.(!!this._prevEntityEnabled); } catch { /* ignore */ }
    this._profileSub?.();
    this._profileResetSub?.();
    this._profileBoundSub?.();
    releaseSprite(this._sprite);
    this._sprite = null;
    super.dispose?.();
  }

  onMouseDown(btn, lx, ly) {
    if (lx < 10 || lx > 10 + VIEWPORT_W || ly < 28 || ly > 28 + VIEWPORT_H) return;
    // Audit rev.4 P2 — RMB on the canvas = drop a user marker at the
    // hit tile. Audit rev.9 P2 #6 — when Plot Route mode is active,
    // RMB instead appends a waypoint to the in-flight route.
    if (btn === 2) {
      const tx = Math.round(this._cx + (lx - 10 - VIEWPORT_W / 2) / this._zoom);
      const ty = Math.round(this._cy + (ly - 28 - VIEWPORT_H / 2) / this._zoom);
      if (this._plotMode) {
        this._route.push({ x: tx, y: ty });
        this._updatePlayerOverlay(true);
      } else {
        this._openMarkerEditor(tx, ty);
      }
      return;
    }
    this._dragging = true;
    this._lastDrag.x = lx;
    this._lastDrag.y = ly;
    // Disable auto-pan when the user grabs the map.
    this._autoPan = false;
  }
  onMouseUp() { this._dragging = false; }

  /** Audit rev.9 P2 #6 — Combobox-driven facet swap. */
  _setFacet(f) {
    this._mapFacet = f | 0;
    try { assets.setFacet?.(this._mapFacet); } catch { /* facet may not be loaded yet */ }
    this._render(true);
    this._updatePlayerOverlay(true);
  }

  _facetName(f) {
    return ['Felucca', 'Trammel', 'Ilshenar', 'Malas', 'Tokuno', 'TerMur'][f] ?? `Facet ${f}`;
  }

  /** Audit rev.9 P2 #6 — toggle Plot Route mode. */
  _togglePlot() {
    this._plotMode = !this._plotMode;
    if (!this._plotMode) {
      // Finalise: persist to profile so the next session sees it.
      try { profile.set?.(`worldmap.routes.${this._mapFacet}`, this._route.slice()); }
      catch { /* localStorage full / SSR */ }
    }
    this._plotBtn.setLabel?.(this._plotMode ? 'Done Route' : 'Plot Route');
    this._updatePlayerOverlay(true);
  }

  /** Audit rev.4 P2 — minimal marker add/edit dialog. Saves the new
   *  marker to `profile.worldmap.markers`; the overlay tick picks
   *  the array up on the next frame. */
  _openMarkerEditor(tx, ty) {
    const cur = Array.isArray(profile.get('worldmap.markers'))
      ? profile.get('worldmap.markers') : [];

    const label = window.prompt(`Marker label for (${tx}, ${ty}):`, '');
    if (label == null) return;
    const trimmed = label.trim();
    if (!trimmed) return;

    const hexInput = window.prompt('Color (hex, e.g. ffd06a):', 'ffd06a');
    const color = parseInt((hexInput || 'ffd06a').replace(/[^0-9a-fA-F]/g, ''), 16) || 0xffd06a;
    const next = [...cur, { x: tx, y: ty, label: trimmed, color, facet: this._mapFacet }];
    profile.set('worldmap.markers', next);
  }

  /** Drag-to-pan — UIManager dispatches when the held button is moved. */
  onMouseMove(lx, ly) {
    if (!this._dragging) return;
    const ddx = lx - this._lastDrag.x;
    const ddy = ly - this._lastDrag.y;
    if (ddx === 0 && ddy === 0) return;
    this._cx -= ddx / this._zoom;
    this._cy -= ddy / this._zoom;
    this._lastDrag.x = lx;
    this._lastDrag.y = ly;
    this._render();
    this._updatePlayerOverlay(true);
  }

  /** Mouse-wheel zoom — clamp 1..8 px/tile. */
  onMouseWheel(dir) {
    const next = Math.max(1, Math.min(8, this._zoom + (dir > 0 ? 1 : -1)));
    if (next === this._zoom) return;
    this._zoom = next;
    profile.set?.('worldmap.zoom', next);
    this._render(true);
    this._updatePlayerOverlay(true);
  }

  /** Called from GameScene tick. */
  tick(dt) {
    this._lastRedraw += dt;
    if (this._autoPan && world.player) {
      this._cx = world.player.x;
      this._cy = world.player.y;
    }
    if (this._lastRedraw < 0.5) {
      this._updatePlayerOverlay(false);
      return;
    }
    this._lastRedraw = 0;
    this._render();
    this._updatePlayerOverlay(true);
  }

  _updatePlayerOverlay(repaintOverlay = true) {
    if (!world.player) { this._playerDot.visible = false; return; }
    this._playerDot.visible = true;
    const dx = (world.player.x - this._cx) * this._zoom;
    const dy = (world.player.y - this._cy) * this._zoom;
    this._playerDot.position.set(10 + VIEWPORT_W / 2 + dx, 28 + VIEWPORT_H / 2 + dy);

    // Coord read-out under the canvas.
    const cx = (this._cx | 0), cy = (this._cy | 0);
    this._coordLabel.node.visible = this._showCoordinates;
    const coordText = `(${cx}, ${cy}) z=${this._zoom}  player=(${world.player.x | 0},${world.player.y | 0})`;
    if (this._coordText !== coordText) {
      this._coordText = coordText;
      this._coordLabel.setText?.(coordText);
    }

    if (!repaintOverlay) return;

    const savedRoute = profile.get?.(`worldmap.routes.${this._mapFacet}`);
    const ovFacet = this._mapFacet | 0;
    const ovCx = Math.round(this._cx * 10);
    const ovCy = Math.round(this._cy * 10);
    const ovZoom = this._zoom | 0;
    const ovPlayerX = world.player.x | 0;
    const ovPlayerY = world.player.y | 0;
    const ovMap = world.mapId | 0;
    const ovMobileRev = world._mobileSpatialRevision ?? 0;
    const ovEntityRev = worldMapEntities.revision ?? 0;
    const ovShowParty = this._showParty;
    const ovShowGuild = this._showGuild;
    const ovShowMarkers = this._showMarkers;
    const ovShowMobiles = this._showMobiles;
    const ovShowGrid = this._showGrid;
    const ovMarkerSize = this._markerSize;
    const ovMarkersLen = Array.isArray(profile.settings?.worldmap?.markers) ? profile.settings.worldmap.markers.length : 0;
    const ovPlotMode = this._plotMode ? 1 : 0;
    const ovRouteLen = this._route?.length ?? 0;
    const ovSavedRouteLen = Array.isArray(savedRoute) ? savedRoute.length : 0;
    const overlayNow = performance.now();
    if (ovFacet === this._ovFacet
        && ovCx === this._ovCx
        && ovCy === this._ovCy
        && ovZoom === this._ovZoom
        && ovPlayerX === this._ovPlayerX
        && ovPlayerY === this._ovPlayerY
        && ovMap === this._ovMap
        && ovMobileRev === this._ovMobileRev
        && ovEntityRev === this._ovEntityRev
        && ovShowParty === this._ovShowParty
        && ovShowGuild === this._ovShowGuild
        && ovShowMarkers === this._ovShowMarkers
        && ovShowMobiles === this._ovShowMobiles
        && ovShowGrid === this._ovShowGrid
        && ovMarkerSize === this._ovMarkerSize
        && ovMarkersLen === this._ovMarkersLen
        && ovPlotMode === this._ovPlotMode
        && ovRouteLen === this._ovRouteLen
        && ovSavedRouteLen === this._ovSavedRouteLen
        && overlayNow - this._lastOverlayPaintAt < 2000) return;
    this._ovFacet = ovFacet;
    this._ovCx = ovCx;
    this._ovCy = ovCy;
    this._ovZoom = ovZoom;
    this._ovPlayerX = ovPlayerX;
    this._ovPlayerY = ovPlayerY;
    this._ovMap = ovMap;
    this._ovMobileRev = ovMobileRev;
    this._ovEntityRev = ovEntityRev;
    this._ovShowParty = ovShowParty;
    this._ovShowGuild = ovShowGuild;
    this._ovShowMarkers = ovShowMarkers;
    this._ovShowMobiles = ovShowMobiles;
    this._ovShowGrid = ovShowGrid;
    this._ovMarkerSize = ovMarkerSize;
    this._ovMarkersLen = ovMarkersLen;
    this._ovPlotMode = ovPlotMode;
    this._ovRouteLen = ovRouteLen;
    this._ovSavedRouteLen = ovSavedRouteLen;
    this._lastOverlayPaintAt = overlayNow;

    // Repaint blip overlay (party + guild + user markers).
    this._overlay.clear();
    const showParty = this._showParty;
    const showGuild = this._showGuild;
    const showMarkers = this._showMarkers;
    const showMobiles = this._showMobiles;
    const showGrid = this._showGrid && this._zoom >= 4;
    const markerSize = this._markerSize;
    const blipRadius = Math.max(2, Math.round(markerSize / 3));
    const markerRadius = Math.max(3, Math.round(markerSize / 2));
    this._resetVisibleSerials();
    this.worldMapStats.mobilePins = 0;
    this.worldMapStats.mobileClusters = 0;
    this.worldMapStats.markerPins = 0;
    this.worldMapStats.markerClusters = 0;

    if (showGrid) {
      const xMin = Math.ceil(this._cx - VIEWPORT_W / 2 / this._zoom);
      const xMax = Math.floor(this._cx + VIEWPORT_W / 2 / this._zoom);
      const yMin = Math.ceil(this._cy - VIEWPORT_H / 2 / this._zoom);
      const yMax = Math.floor(this._cy + VIEWPORT_H / 2 / this._zoom);
      for (let tx = xMin; tx <= xMax; tx++) {
        const x = this._screenX(tx);
        this._overlay.moveTo(x, 28).lineTo(x, 28 + VIEWPORT_H)
          .stroke({ width: 1, color: 0x2a2418, alpha: 0.35 });
      }
      for (let ty = yMin; ty <= yMax; ty++) {
        const y = this._screenY(ty);
        this._overlay.moveTo(10, y).lineTo(10 + VIEWPORT_W, y)
          .stroke({ width: 1, color: 0x2a2418, alpha: 0.35 });
      }
    }

    // Party blue / guild green dots.
    if (showParty || showGuild) {
      const drawEntityPin = (ent) => {
        if (!ent || ent.serial === world.player.serial) return;
        if ((ent.map ?? world.mapId ?? 0) !== (this._mapFacet | 0)) return;
        const x = this._screenX(ent.x);
        const y = this._screenY(ent.y);
        if (!this._inWindow(x, y)) return;
        const isGuild = !!ent.isGuild;
        const color = isGuild ? 0x00ff80 : 0x60c0ff;
        if ((!isGuild && !showParty) || (isGuild && !showGuild)) return;
        this._addVisibleSerial(ent.serial >>> 0);
        this._overlay.circle(x, y, blipRadius).fill({ color });
      };
      if (worldMapEntities.forEachPin) {
        worldMapEntities.forEachPin(drawEntityPin);
      } else {
        for (const ent of worldMapEntities.getPins?.() ?? []) drawEntityPin(ent);
      }
    }
    if (showMobiles) {
      const mapId = this._mapFacet | 0;
      const clusterMobiles = this._zoom <= 2;
      if (clusterMobiles) this._mobileClusterBuckets.clear();
      const radius = Math.max(
        Math.ceil(VIEWPORT_W / 2 / Math.max(1, this._zoom)) + 1,
        Math.ceil(VIEWPORT_H / 2 / Math.max(1, this._zoom)) + 1,
      );
      const drawMobile = (mob) => {
        if (!mob || mob.serial === world.player.serial) return;
        if (this._hasVisibleSerial(mob.serial >>> 0)) return;
        if ((mob.map ?? world.mapId ?? 0) !== mapId) return;
        const x = this._screenX(mob.x);
        const y = this._screenY(mob.y);
        if (!this._inWindow(x, y)) return;
        const color = mob.notoriety >= 5 ? 0xff6060 : mob.notoriety === 2 ? 0x60ff90 : 0xffd06a;
        this.worldMapStats.mobilePins++;
        if (clusterMobiles) {
          this._addOverlayCluster(this._mobileClusterBuckets, x, y, color, 22);
          return;
        }
        this._overlay.circle(x, y, Math.max(2, blipRadius - 1)).fill({ color, alpha: 0.8 });
      };
      if (typeof world.forEachMobileNear === 'function') {
        world.forEachMobileNear(this._cx | 0, this._cy | 0, mapId, radius, true, drawMobile);
      } else {
        const mobiles = typeof world.mobilesNear === 'function'
          ? world.mobilesNear(this._cx | 0, this._cy | 0, mapId, radius, true)
          : (world.mobiles?.values?.() ?? []);
        for (const mob of mobiles) drawMobile(mob);
      }
      if (clusterMobiles) {
        this.worldMapStats.mobileClusters = this._drawOverlayClusters(
          this._mobileClusterBuckets,
          Math.max(2, blipRadius - 1),
          'circle',
        );
      }
    }

    // User markers (pinpinks).
    const markers = profile.get?.('worldmap.markers') ?? profile.settings?.worldmap?.markers;
    if (showMarkers && Array.isArray(markers)) {
      const clusterMarkers = this._zoom <= 2;
      if (clusterMarkers) this._markerClusterBuckets.clear();
      for (const m of markers) {
        if ((m.facet ?? this._mapFacet) !== this._mapFacet) continue;
        const x = this._screenX(m.x);
        const y = this._screenY(m.y);
        if (!this._inWindow(x, y)) continue;
        const color = m.color ?? 0xffd06a;
        this.worldMapStats.markerPins++;
        if (clusterMarkers) {
          this._addOverlayCluster(this._markerClusterBuckets, x, y, color, 28);
          continue;
        }
        this._overlay.poly([
          x, y - markerRadius,
          x + markerRadius, y,
          x, y + markerRadius,
          x - markerRadius, y,
        ]).fill({ color });
      }
      if (clusterMarkers) {
        this.worldMapStats.markerClusters = this._drawOverlayClusters(
          this._markerClusterBuckets,
          markerRadius,
          'diamond',
        );
      }
    }

    // Audit rev.9 P2 #6 — Plot Route polyline + waypoint dots.
    // Re-render in two passes: (a) yellow polyline for the route
    // segments, (b) yellow dots at each waypoint, plus an index label.
    // Saved routes are also walked from the profile so a finalised
    // route keeps rendering after the user toggles plot mode off.
    if (this._plotMode || this._route?.length) {
      this._drawRoute(this._route, this._plotMode ? 0xffe080 : 0x80c0ff);
    }
    if (!this._plotMode && Array.isArray(savedRoute) && savedRoute.length) {
      this._drawRoute(savedRoute, 0x80c0ff);
    }
  }

  _screenX(tx) {
    return 10 + VIEWPORT_W / 2 + (tx - this._cx) * this._zoom;
  }

  _screenY(ty) {
    return 28 + VIEWPORT_H / 2 + (ty - this._cy) * this._zoom;
  }

  _inWindow(x, y) {
    return x >= 10 && x <= 10 + VIEWPORT_W && y >= 28 && y <= 28 + VIEWPORT_H;
  }

  _resetVisibleSerials() {
    this._visibleSerialCount = 0;
  }

  _ensureVisibleSerialCapacity(nextCount) {
    if (nextCount <= this._visibleSerials.length) return;
    let size = this._visibleSerials.length || 32;
    while (size < nextCount) size <<= 1;
    const next = new Uint32Array(size);
    next.set(this._visibleSerials.subarray(0, this._visibleSerialCount));
    this._visibleSerials = next;
  }

  _addVisibleSerial(serial) {
    const s = serial >>> 0;
    if (!s || this._hasVisibleSerial(s)) return;
    const count = this._visibleSerialCount | 0;
    this._ensureVisibleSerialCapacity(count + 1);
    this._visibleSerials[count] = s;
    this._visibleSerialCount = count + 1;
  }

  _hasVisibleSerial(serial) {
    const s = serial >>> 0;
    if (!s) return false;
    const list = this._visibleSerials;
    for (let i = 0; i < this._visibleSerialCount; i++) {
      if (list[i] === s) return true;
    }
    return false;
  }

  _clusterKey(x, y, cellSize) {
    const cx = Math.floor((x - 10) / cellSize);
    const cy = Math.floor((y - 28) / cellSize);
    return ((cy & 0xffff) * 0x10000) + (cx & 0xffff);
  }

  _addOverlayCluster(buckets, x, y, color, cellSize) {
    const key = this._clusterKey(x, y, cellSize);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { x: 0, y: 0, count: 0, color };
      buckets.set(key, bucket);
    }
    bucket.x += x;
    bucket.y += y;
    bucket.count++;
  }

  _drawOverlayClusters(buckets, baseRadius, shape = 'circle') {
    let drawn = 0;
    for (const bucket of buckets.values()) {
      const count = bucket.count | 0;
      if (count <= 0) continue;
      const x = bucket.x / count;
      const y = bucket.y / count;
      const radius = count === 1 ? baseRadius : Math.min(baseRadius + 6, baseRadius + Math.ceil(Math.sqrt(count)));
      const alpha = count === 1 ? 0.82 : 0.92;
      if (shape === 'diamond') {
        this._overlay.poly([
          x, y - radius,
          x + radius, y,
          x, y + radius,
          x - radius, y,
        ]).fill({ color: bucket.color, alpha });
      } else {
        this._overlay.circle(x, y, radius).fill({ color: bucket.color, alpha });
      }
      if (count > 1) {
        this._overlay.circle(x, y, Math.max(1, Math.floor(radius / 3))).fill({ color: 0xffffff, alpha: 0.72 });
      }
      drawn++;
    }
    return drawn;
  }

  _drawRoute(route, hue = 0xffe080) {
    if (!route || route.length < 1) return;
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    for (let i = 0; i < route.length; i++) {
      const x = this._screenX(route[i].x);
      const y = this._screenY(route[i].y);
      if (hasPrev) {
        this._overlay.moveTo(prevX, prevY).lineTo(x, y)
          .stroke({ width: 2, color: hue, alpha: 0.85 });
      }
      if (this._inWindow(x, y)) {
        this._overlay.circle(x, y, 4).fill({ color: hue });
      }
      prevX = x;
      prevY = y;
      hasPrev = true;
    }
  }

  _render(force = false) {
    if (!this._ctx) return;
    const zoom = Math.max(1, this._zoom | 0);
    const halfW = VIEWPORT_W / 2 / zoom;
    const halfH = VIEWPORT_H / 2 / zoom;
    const x0 = Math.floor(this._cx - halfW);
    const y0 = Math.floor(this._cy - halfH);
    const radarRev = assets.radarcol?.land?.length ?? 0;
    const facet = this._mapFacet | 0;
    if (!force
        && facet === this._lastTerrainFacet
        && zoom === this._lastTerrainZoom
        && radarRev === this._lastTerrainRadarRev
        && x0 === this._lastTerrainX0
        && y0 === this._lastTerrainY0) return false;
    this._lastTerrainFacet = facet;
    this._lastTerrainZoom = zoom;
    this._lastTerrainRadarRev = radarRev;
    this._lastTerrainX0 = x0;
    this._lastTerrainY0 = y0;
    const w  = Math.ceil(VIEWPORT_W / zoom);
    const h  = Math.ceil(VIEWPORT_H / zoom);

    const px32 = this._pixelsU32;
    px32.fill(0xff000000); // RGBA little-endian; alpha=0xFF, RGB=0
    // Hot loop. Two specialisations:
    //   zoom == 1 → one pixel per tile, single Uint32 store per iter.
    //   zoom >  1 → block fill of `zoom × zoom` pixels per tile.
    if (zoom === 1) {
      for (let dy = 0; dy < h; dy++) {
        const row = dy * VIEWPORT_W;
        const ty = y0 + dy;
        for (let dx = 0; dx < w; dx++) {
          const land = assets.landAt(x0 + dx, ty);
          px32[row + dx] = land ? packedLandRadarColor(land.id) : 0xff000000;
        }
      }
    } else {
      for (let dy = 0; dy < h; dy++) {
        const ty = y0 + dy;
        for (let dx = 0; dx < w; dx++) {
          const land = assets.landAt(x0 + dx, ty);
          const packed = land ? packedLandRadarColor(land.id) : 0xff000000;
          const baseY = dy * zoom;
          const baseX = dx * zoom;
          const span = Math.min(zoom, VIEWPORT_W - baseX);
          if (span <= 0) continue;
          for (let py = 0; py < zoom; py++) {
            const row = (baseY + py) * VIEWPORT_W + baseX;
            if (row < 0 || row >= px32.length) continue;
            px32.fill(packed, row, row + span);
          }
        }
      }
    }
    this._ctx.putImageData(this._imgData, 0, 0);
    this._tex.source.update();
  }
}
