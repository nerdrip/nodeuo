// Camera — follows the player. Mirrors ClassicUO's Renderer/Camera.cs.
//
// ClassicUO supports a resizable gameplay viewport (drag the bottom-
// right corner of the game window to grow it). In the browser we mirror
// that by sizing the gameplay rectangle to the *browser window* minus
// a small margin for the chat strip — when the user enlarges the tab,
// the playable world grows with it.

import { worldToScreenX, worldToScreenY } from './iso.js';
import { bus } from '../core/event-bus.js';
import { assets } from '../assets/asset-manager.js';
import { world } from '../world/world.js';

export const GAME_VIEW_MARGIN = 8;
export const MIN_VIEW_W = 640;
export const MIN_VIEW_H = 480;
export const GAME_VIEW_ASPECT = 16 / 10;
// Fixed chat (60 px) + a 100 px action-bar deck. Treating both as part of
// the workspace prevents the hotbar from covering the world on the user's
// short 2048x732 display while centering the combined world+hotbar group.
const GAME_FOOTER_H = 160;
const SIDE_RAIL_MIN = 310;
const SIDE_RAIL_MAX = 360;
const COMPACT_SIDE_RAIL_MIN = 220;
const COMPACT_SIDE_RAIL_MAX = 260;

// Discrete zoom steps. Picked so TILE_HALF_W (22) × zoom lands on (or
// very close to) integer pixels, keeping adjacent diamond edges in
// register and avoiding the "gap between tiles at certain wheel
// positions" rendering bug. Steps: 0.5, 0.75, 1.0, 1.25, 1.5, 2.0,
// 3.0, 4.0 — matches CUO's wheel cadence except we drop the noisy
// 0.6/0.7/0.8/0.9 stops that produced sub-pixel scales.
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];

// v2 intentionally ignores the old top-left 640/680×480 layout. Those
// values were persisted when the canvas was a CUO-style floating window and
// are the reason a modern wide screen could still open with a tiny world in
// its top-left corner. New manual sizes are persisted under the new key.
const STORAGE_KEY = 'uo.viewport.v2';

/** Compute the modern game workspace. On desktop the world is a 16:10
 * rectangle centered between two useful side rails. On compact displays the
 * rails collapse and the world consumes the available width. Exported for
 * deterministic layout smoke tests. */
export function calculateResponsiveViewport(browserW, browserH, { compactSidePanels = false } = {}) {
  const bw = Math.max(320, Math.floor(Number(browserW) || 0));
  const bh = Math.max(240, Math.floor(Number(browserH) || 0));
  const margin = GAME_VIEW_MARGIN;
  const desktop = bw >= 1400;
  const railMin = compactSidePanels ? COMPACT_SIDE_RAIL_MIN : SIDE_RAIL_MIN;
  const railMax = compactSidePanels ? COMPACT_SIDE_RAIL_MAX : SIDE_RAIL_MAX;
  const rail = desktop
    ? Math.max(railMin, Math.min(railMax, Math.round(bw * (compactSidePanels ? 0.11 : 0.15))))
    : margin;
  const availableW = Math.max(320, bw - rail * 2 - margin * 2);
  const availableH = Math.max(240, bh - GAME_FOOTER_H - margin * 2);

  let w = Math.min(availableW, Math.floor(availableH * GAME_VIEW_ASPECT));
  let h = Math.min(availableH, Math.floor(w / GAME_VIEW_ASPECT));
  // Keep the exact aspect instead of independently clamping width/height —
  // independent minimums distorted the world rectangle around 1366 px.
  w = Math.max(320, w);
  h = Math.max(200, Math.floor(w / GAME_VIEW_ASPECT));
  return {
    x: Math.round((bw - w) / 2),
    y: margin + Math.round((availableH - h) / 2),
    w,
    h,
    leftRailW: Math.max(0, Math.round((bw - w) / 2) - margin * 2),
    rightRailW: Math.max(0, Math.round((bw - w) / 2) - margin * 2),
  };
}

/** Persisted user-chosen viewport size — when set, overrides
 *  setViewport's "fit-to-window" auto-sizing. Drag-resize stores it. */
function loadStoredSize() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v.w === 'number' && typeof v.h === 'number') return v;
  } catch { /* ignore */ }
  return null;
}
function saveStoredSize(w, h) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ w, h })); }
  catch { /* ignore */ }
}

export class Camera {
  constructor() {
    this.worldX = 0;
    this.worldY = 0;
    this.worldZ = 0;
    /** ClassicUO render-multiplier (44×22 tile → 132×66 on screen at 3×).
     *  Default 3 (was 2) so the canonical 22×39 idle body renders at
     *  ~66×117 px. At 2×
     *  a male body comes out 44×78, easily lost against a brick floor.
     *  Use mouse wheel to zoom in further (max 4×) or out (min 0.5×). */
    // CUO default zoom is 1.0 (Constants.cs `DEFAULT_ZOOM = 1`).
    // Higher values exaggerate iso seam artefacts and inflate the
    // pixel-distance hit-test math; user can wheel up afterwards.
    this.zoom = 1;
    this.viewW = MIN_VIEW_W;
    this.viewH = MIN_VIEW_H;
    this.viewX = GAME_VIEW_MARGIN;
    this.viewY = GAME_VIEW_MARGIN;
    this.cx = 0;
    this.cy = 0;
    /** When set, the user has manually drag-resized the viewport and
     *  we should respect that size on every subsequent setViewport. */
    this.userSizedW = null;
    this.userSizedH = null;
    const stored = loadStoredSize();
    if (stored) {
      this.userSizedW = stored.w;
      this.userSizedH = stored.h;
    }
  }

  /** Adjust zoom and clamp to CUO's range. Persists nothing — zoom is
   *  per-session. CUO supports 0.5x..2.0x; we go a bit wider for
   *  usability on big monitors.
   *
   *  IMPORTANT: zoom must produce screen-space tile sizes that round
   *  consistently across adjacent tiles, otherwise the renderer leaves
   *  1-pixel seams between diamond edges. The 44×22 land tile half-
   *  extents (TILE_HALF_W=22, TILE_HALF_H=22) align cleanly only when
   *  HALF * zoom is an integer — i.e. zoom ∈ multiples of 1/22.
   *
   *  Picking values that ALSO map nicely to the static-art 22×anything
   *  step gives us this curated table: 0.5, 0.75, 1.0, 1.25, 1.5, 2.0,
   *  3.0, 4.0. zoomIn/zoomOut step through it instead of multiplying
   *  by 1.25 (which produces 1.953125 and other half-pixel scales that
   *  manifest as the gap-between-tiles bug at certain wheel positions).
   */
  setZoom(z) {
    this.zoom = ZOOM_STEPS.reduce(
      (best, s) => Math.abs(s - z) < Math.abs(best - z) ? s : best,
      ZOOM_STEPS[0],
    );
  }
  zoomIn() {
    const i = ZOOM_STEPS.indexOf(this.zoom);
    this.zoom = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 3 : i) + 1)];
  }
  zoomOut() {
    const i = ZOOM_STEPS.indexOf(this.zoom);
    this.zoom = ZOOM_STEPS[Math.max(0, (i < 0 ? 3 : i) - 1)];
  }

  /** Called by the drag-resize handle. Persists the new size. The
   *  caller may overshoot during a fast drag — clamp to the current
   *  window so `setUserSize(99999, 99999)` doesn't leave viewW past
   *  the device backbuffer until the next browser resize. Mirrors
   *  CUO `Renderer/Camera.cs::SetBounds` clamp. */
  setUserSize(w, h) {
    const maxW = (typeof window !== 'undefined' ? window.innerWidth  : 1920) - GAME_VIEW_MARGIN * 2;
    const maxH = (typeof window !== 'undefined' ? window.innerHeight : 1080) - GAME_VIEW_MARGIN * 2 - 56;
    this.userSizedW = Math.max(MIN_VIEW_W, Math.min(maxW, Math.floor(w)));
    this.userSizedH = Math.max(MIN_VIEW_H, Math.min(maxH, Math.floor(h)));
    this.viewW = this.userSizedW;
    this.viewH = this.userSizedH;
    saveStoredSize(this.userSizedW, this.userSizedH);
    // Audit #46 P2 — emit `camera:resized` so a profile-manager-aware
    // subscriber can mirror to `ui.gameWindowW/H`. CUO `Profile.cs::
    // GameWindowSize` ships the same trio.
    try { bus.emit('camera:resized', { w: this.userSizedW, h: this.userSizedH }); } catch { /* ignore */ }
  }

  /** Audit #46 P2 — set explicit viewport origin (top-left). Honours
   *  the lock: when `ui.gameWindowLock` is true subsequent
   *  `setUserSize` / browser-resize hooks won't move the rect. */
  setUserPosition(x, y) {
    this.viewX = Math.max(0, x | 0);
    this.viewY = Math.max(0, y | 0);
    this._userPositioned = true;
    try { bus.emit('camera:moved', { x: this.viewX, y: this.viewY }); } catch { /* ignore */ }
  }

  /** Audit #46 P2 — apply saved gameWindow {X,Y,W,H,Lock} from profile
   *  on first frame after login. Call once from main.js. */
  applyProfileViewport(profile) {
    const x = profile?.get?.('ui.gameWindowX');
    const y = profile?.get?.('ui.gameWindowY');
    const w = profile?.get?.('ui.gameWindowW');
    const h = profile?.get?.('ui.gameWindowH');
    const locked = !!profile?.get?.('ui.gameWindowLock');
    // Old profiles saved the former tiny top-left viewport even when the
    // player never asked to lock it. Only an explicitly locked profile is a
    // deliberate fixed workspace; otherwise v2 responsive layout wins.
    if (locked && w > 0 && h > 0) this.setUserSize(w, h);
    if (locked && x >= 0 && y >= 0) {
      this.viewX = x | 0;
      this.viewY = y | 0;
      this._userPositioned = true;
    }
    this._locked = locked;
  }
  isLocked() { return !!this._locked; }

  /** Switch between the normal CUO-sized side workspaces and a compact
   * modern layout. The next setViewport() recomputes the centered world
   * rectangle; persisted manual sizes remain authoritative. */
  setSidePanelMode(compact) {
    this.compactSidePanels = !!compact;
  }

  /** Trigger a quick screen shake. Magnitude in pixels (peak amplitude),
   *  duration in ms. Mirrors CUO's `Renderer.Camera.Shake(magnitude,
   *  duration)` used by explosions, earthquake, paragon ground-pound.
   *  Decays linearly to zero so a small shake disappears cleanly. */
  shake(magnitude = 6, durationMs = 220) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._shakeStart = now;
    this._shakeUntil = now + Math.max(0, durationMs | 0);
    this._shakeMag = Math.max(0, magnitude | 0);
  }

  /** Accumulate a temporary camera peek offset in viewport pixels.
   *  GameScene calls this for middle-mouse "look at mouse" style panning.
   *  Store unscaled screen units so the visible drag distance stays stable
   *  at every zoom level. */
  panBy(dxPx, dyPx) {
    const z = this.zoom || 1;
    this._panOffsetX = (this._panOffsetX || 0) + (Number(dxPx) || 0) / z;
    this._panOffsetY = (this._panOffsetY || 0) + (Number(dyPx) || 0) / z;
  }
  resetPan() { this._panOffsetX = 0; this._panOffsetY = 0; }

  /** @param {import('pixi.js').Container} worldContainer */
  apply(worldContainer) {
    // Pixel-space offset (set by `followWithOffset`) so the camera
    // tracks the PLAYER'S VISUAL position during a walk step instead
    // of jumping a full tile each ack — same iso math as the mobile
    // sprite's offsetX/Y so player + camera stay in lock-step.
    this.cx = worldToScreenX(this.worldX, this.worldY) + (this.offsetX || 0);
    this.cy = worldToScreenY(this.worldX, this.worldY, this.worldZ) + (this.offsetY || 0);
    // Screen-shake offset (decays linearly from peak to zero).
    let shakeX = 0, shakeY = 0;
    if (this._shakeUntil) {
      const now = performance.now();
      if (now < this._shakeUntil) {
        const total = this._shakeUntil - this._shakeStart;
        const left  = (this._shakeUntil - now) / total;
        const amp   = this._shakeMag * left;
        // Two co-prime sine bumps look more "impact-ish" than pure random.
        shakeX = Math.sin(now * 0.05) * amp;
        shakeY = Math.cos(now * 0.07) * amp;
      } else {
        this._shakeUntil = 0;
      }
    }
    this.cx += shakeX;
    this.cy += shakeY;
    // Manual peek/pan offset. Set by `panBy()` from GameScene while the
    // middle mouse button is held; `resetPan()` restores strict follow.
    if (this._panOffsetX || this._panOffsetY) {
      this.cx -= this._panOffsetX;
      this.cy -= this._panOffsetY;
    }
    worldContainer.scale.set(this.zoom, this.zoom);
    // Round the container origin to integer pixels. Without this, a
    // sub-pixel offset (e.g. 0.5 px while lerping between two tiles
    // during a walk step) leaves the GPU sampling the "in-between" row
    // of every tile and shows up as 1-px seams between adjacent
    // diamonds. Pixi's roundPixels=true rounds individual sprite
    // vertices, but the container offset is applied BEFORE that and
    // sets the rounding axis — snapping it here keeps every child on
    // the same integer grid.
    worldContainer.position.set(
      Math.round(this.viewX + this.viewW / 2 - this.cx * this.zoom),
      Math.round(this.viewY + this.viewH / 2 - this.cy * this.zoom),
    );
  }

  setViewport(browserW, browserH) {
    const layout = calculateResponsiveViewport(browserW, browserH, {
      compactSidePanels: !!this.compactSidePanels,
    });
    if (this.userSizedW != null && this.userSizedH != null) {
      // Honour the user's drag-chosen size, but cap to the current window.
      this.viewW = Math.min(this.userSizedW, Math.max(MIN_VIEW_W, browserW - GAME_VIEW_MARGIN * 2));
      this.viewH = Math.min(this.userSizedH, Math.max(MIN_VIEW_H, browserH - GAME_VIEW_MARGIN * 2 - 56));
    } else {
      this.viewW = layout.w;
      this.viewH = layout.h;
    }
    if (!this._userPositioned) {
      // Custom sizes are centered too; resizing the browser never glues the
      // game window back to (8,8).
      this.viewX = Math.round((browserW - this.viewW) / 2);
      this.viewY = GAME_VIEW_MARGIN + Math.round(
        (Math.max(0, browserH - GAME_FOOTER_H - GAME_VIEW_MARGIN * 2 - this.viewH)) / 2,
      );
    } else {
      // Preserve the profile/user origin across browser resizes, while still
      // keeping a reachable sliver of the game viewport on a smaller screen.
      this.viewX = Math.max(0, Math.min(this.viewX, Math.max(0, browserW - 64)));
      this.viewY = Math.max(0, Math.min(this.viewY, Math.max(0, browserH - 64)));
    }
  }

  // Client audit #5 #6 / #6 — facet edge clamp. UO map is 7168×4096
  // tiles; without bounds the camera follows to the corner and the void
  // backdrop shows past the painted facet bins.
  _clamp(x, y) {
    return [this._clampX(x), this._clampY(y)];
  }

  _clampX(x) {
    const W = assets.mapMeta?.width || world.mapWidth || 7168;
    return Math.max(0, Math.min(W - 1, x | 0));
  }

  _clampY(y) {
    const H = assets.mapMeta?.height || world.mapHeight || 4096;
    return Math.max(0, Math.min(H - 1, y | 0));
  }

  follow(x, y, z = 0) {
    const cx = this._clampX(x);
    const cy = this._clampY(y);
    this.worldX = cx;
    this.worldY = cy;
    this.worldZ = z;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  /** Same as `follow`, with extra screen-pixel offset so the camera
   *  can lerp between two tiles during a walk step. Pass the local
   *  player's `offsetX/Y` here every frame. */
  followWithOffset(x, y, z, offX, offY) {
    const cx = this._clampX(x);
    const cy = this._clampY(y);
    this.worldX = cx;
    this.worldY = cy;
    this.worldZ = z;
    this.offsetX = offX || 0;
    this.offsetY = offY || 0;
  }

  visibleTileRadius() {
    const half = (this.viewW + this.viewH) / (2 * 22 * this.zoom);
    return Math.ceil(half) + 2;
  }
}

export const camera = new Camera();
