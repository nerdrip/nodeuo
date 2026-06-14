// GameController — top-level orchestrator. Mirrors ClassicUO's
// GameController.cs (FNA Game subclass). Owns:
//   - the Pixi Application (world layer + UI overlay containers)
//   - the active Scene (LoginScene / GameScene)
//   - the global ticker that drives Time + Scene.update + Scene.draw
//
// Scene swap is synchronous from the caller's POV (await setScene(next)).

import { Application, Container } from 'pixi.js';
import { Time, tickClock } from './time.js';
import { bus } from './event-bus.js';

const LONG_TASK_THRESHOLD_MS = 50;
const LONG_TASK_HISTORY_SIZE = 32;

export const clientPerfStats = {
  frameMs: 0,
  eventLoopLagMs: 0,
  updateMs: 0,
  drawMs: 0,
  tickMs: 0,
  maxEventLoopLagMs: 0,
  longTaskThresholdMs: LONG_TASK_THRESHOLD_MS,
  longTaskCount: 0,
  lastLongTaskMs: 0,
  maxLongTaskMs: 0,
  longTaskHead: 0,
  longTaskHistory: Array.from({ length: LONG_TASK_HISTORY_SIZE }, () => ({
    at: 0, ms: 0, frameMs: 0, lagMs: 0,
  })),
};

export function recordClientLongTask(ms, now = performance.now(), frameMs = ms, lagMs = 0) {
  const value = Math.max(0, Number(ms) || 0);
  const idx = clientPerfStats.longTaskHead % LONG_TASK_HISTORY_SIZE;
  const entry = clientPerfStats.longTaskHistory[idx];
  entry.at = now;
  entry.ms = value;
  entry.frameMs = Math.max(0, Number(frameMs) || 0);
  entry.lagMs = Math.max(0, Number(lagMs) || 0);
  clientPerfStats.longTaskHead = (clientPerfStats.longTaskHead + 1) >>> 0;
  clientPerfStats.longTaskCount++;
  clientPerfStats.lastLongTaskMs = value;
  if (value > clientPerfStats.maxLongTaskMs) clientPerfStats.maxLongTaskMs = value;
  return entry;
}

export class GameController {
  /** @param {HTMLElement} mountPoint */
  constructor(mountPoint) {
    this.mountPoint = mountPoint;
    /** @type {Application} */
    this.app = new Application();
    /** @type {Container} world layer (camera-transformed isometric scene) */
    this.world = new Container();
    /** @type {Container} screen-space overlay that sits ABOVE the world
     *  but BELOW all gumps — owns the night/dim rect, weather particles,
     *  point lights. Untransformed (no camera scale) so a full-viewport
     *  Graphics rect renders 1:1 in screen pixels, but rendered before
     *  `ui` so UIManager gumps always stay on top. */
    this.worldOverlay = new Container();
    /** @type {Container} ui overlay layer (untransformed, Y-down screen space) */
    this.ui = new Container();
    /** @type {import('./scene.js').Scene | null} */
    this.scene = null;

    this._statusEl = document.getElementById('status');
    this._domUi = document.getElementById('dom-ui');
    this._lastTickAt = 0;
  }

  async init() {
    await this.app.init({
      resizeTo: this.mountPoint,
      antialias: false,
      autoDensity: true,
      // Resolution=1 forces integer-pixel rendering. ClassicUO's
      // UltimaBatcher2D paints at native resolution; >1 caused our
      // 44×22 diamond sprites to bleed at chunk seams.
      resolution: 1,
      backgroundColor: 0x143a5a,  // ocean blue
      // WebGL2 preferred — Pixi v8's WebGPU backend uses a single
      // global UniformBufferBatch capped at ~256KB which overflows on
      // dense scenes ("UniformBufferBatch: ubo batch got too big"
      // thrown from UboBatch.addEmptyGroup). Every filter push, every
      // hued sprite, every per-mob ColorMatrixFilter (hidden/dead
      // desaturate) and per-mob HueFilter (tinted bodies) consumes a
      // UBO slot, and a city-scale scene with ~50 mobs + lighting +
      // weather + death-screen overlay regularly hits the cap.
      //
      // Both backends are supported by the hue filter — `hue-filter.js`
      // ships matching GLSL + WGSL shaders since the v8 audit. Switching
      // back to WebGPU is safe once the per-mob filter pattern is
      // refactored to a shared singleton (see ColorMatrixFilter usage
      // in `mobile-renderer.js`).
      preference: 'webgl',
      roundPixels: true,
    });
    this.mountPoint.appendChild(this.app.canvas);
    // Renderer diagnostic — surfaces whether Pixi fell back from
    // WebGPU to WebGL2. `preference: 'webgpu'` is a hint; some
    // GPUs/browsers (older Chrome on Linux, Firefox without flag)
    // still return a WebGL2 renderer. Knowing which is in play
    // helps debug perf regressions and visual diffs vs CUO.
    try {
      const r = this.app.renderer;
      const type = r?.type === 1 ? 'WebGL' : (r?.type === 2 ? 'WebGPU' : 'unknown');
      console.log(`[pixi] renderer=${type} resolution=${r?.resolution} roundPixels=${r?.roundPixels} (preference was WebGPU)`);
    } catch { /* ignore */ }

    // Layer order: world → world-overlay → ui. Day/night dim, weather
    // and screen-space point lights mount on `worldOverlay` so they
    // tint the game viewport but never paint over gumps.
    this.app.stage.addChild(this.world, this.worldOverlay, this.ui);

    // FPS cap — read once at init from localStorage `uo.fpsCap`. 0 / unset
    // = uncapped (Pixi runs at vsync rate, which can be 144Hz+ on modern
    // displays). Clamp to a sane range so users can't paint themselves
    // into a corner with `fpsCap=1`.
    try {
      const cap = parseInt(localStorage.getItem('uo.fpsCap') ?? '0', 10);
      if (Number.isFinite(cap) && cap > 0) {
        this.app.ticker.maxFPS = Math.max(15, Math.min(240, cap));
      }
    } catch { /* localStorage unavailable in some test envs */ }

    this.app.ticker.add(this._tick, this);

    // Throttle the Pixi ticker hard when the tab is hidden. Browsers
    // already throttle requestAnimationFrame to ~1 Hz on background
    // tabs, but Pixi can still chew CPU running its `_tick` cadence
    // tracker against system time. Drop maxFPS to 1 while hidden +
    // restore the user-chosen cap on visibility change.
    this._fpsCapBeforeHide = this.app.ticker.maxFPS || 0;
    this._onVisibility = () => {
      if (document.hidden) {
        this._fpsCapBeforeHide = this.app.ticker.maxFPS || 0;
        this.app.ticker.maxFPS = 1;
      } else {
        this.app.ticker.maxFPS = this._fpsCapBeforeHide;
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    // Single bound handler — registered once at init, never re-added on
    // scene swap. Earlier code created an arrow on every init() which
    // would have leaked when (rare) GameController instances were
    // recreated (e.g. tests). Keep the reference so destroy() can detach.
    this._onResize = () => {
      this.scene?.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = null;
    }
    try { this.app.ticker.remove(this._tick, this); } catch { /* noop */ }
    if (this.scene) { try { this.scene.unload(); } catch { /* noop */ } this.scene = null; }
    try { this.app.destroy(true, { children: true }); } catch { /* noop */ }
  }

  /** @param {import('./scene.js').Scene} next */
  async setScene(next) {
    if (this.scene) {
      try { this.scene.unload(); }
      catch (e) { console.error('[gc] scene.unload threw', e); }
      this.world.removeChildren();
      this.worldOverlay.removeChildren();
      this.ui.removeChildren();
      // Drop any DOM the previous scene mounted under #dom-ui.
      while (this._domUi.firstChild) this._domUi.firstChild.remove();
    }
    this.scene = next;
    await next.load();
    next.resize(window.innerWidth, window.innerHeight);
  }

  setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text ?? '';
  }

  /** Live setter for the FPS cap (called from OptionsGump). 0 = uncapped. */
  setFpsCap(fps) {
    const v = Number.isFinite(+fps) ? Math.max(0, Math.min(240, +fps | 0)) : 0;
    if (v <= 0) {
      this.app.ticker.maxFPS = 0;             // uncapped
      try { localStorage.removeItem('uo.fpsCap'); } catch { /* noop */ }
    } else {
      this.app.ticker.maxFPS = Math.max(15, v);
      try { localStorage.setItem('uo.fpsCap', String(v)); } catch { /* noop */ }
    }
  }

  /** Mount a DOM element under the overlay div. Caller owns removal. */
  domMount(el) {
    this._domUi.appendChild(el);
    return () => el.remove();
  }

  _tick() {
    const now = performance.now();
    if (this._lastTickAt) {
      const frameMs = now - this._lastTickAt;
      const expectedMs = Math.max(0, (Time.delta || 0) * 1000);
      const lag = Math.max(0, frameMs - expectedMs);
      clientPerfStats.frameMs = frameMs;
      clientPerfStats.eventLoopLagMs = lag;
      if (lag > clientPerfStats.maxEventLoopLagMs) clientPerfStats.maxEventLoopLagMs = lag;
      if (frameMs >= LONG_TASK_THRESHOLD_MS) {
        recordClientLongTask(frameMs, now, frameMs, lag);
      }
    }
    this._lastTickAt = now;
    tickClock(now);
    // Frame heartbeat for managers/UI that need a per-frame timer (e.g.
    // delayedClickManager firing single-clicks after the DC window expires).
    bus.emit('frame:tick', now);
    const updateStart = performance.now();
    this.scene?.update(Time.delta, now);
    const drawStart = performance.now();
    this.scene?.draw();
    const done = performance.now();
    clientPerfStats.updateMs = drawStart - updateStart;
    clientPerfStats.drawMs = done - drawStart;
    clientPerfStats.tickMs = done - now;
  }
}
