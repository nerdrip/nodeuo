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
import { AdaptiveRenderScale, clientPerformanceGovernor, clientRuntimeProfile } from '../shared/runtime-governor.js';
import { profile as profileManager } from '../managers/profile-manager.js';

const LONG_TASK_THRESHOLD_MS = 50;
const LONG_TASK_HISTORY_SIZE = 32;

export const clientPerfStats = {
  frameMs: 0,
  eventLoopLagMs: 0,
  updateMs: 0,
  drawMs: 0,
  tickMs: 0,
  renderScale: 1,
  maxEventLoopLagMs: 0,
  longTaskThresholdMs: LONG_TASK_THRESHOLD_MS,
  longTaskCount: 0,
  lastLongTaskMs: 0,
  maxLongTaskMs: 0,
  qualityLevel: clientPerformanceGovernor.level,
  frameP50Ms: 0,
  frameP95Ms: 0,
  frameP99Ms: 0,
  heapUsedBytes: 0,
  heapLimitBytes: 0,
  measuredMemoryBytes: 0,
  storageUsageBytes: 0,
  storageQuotaBytes: 0,
  renderer: 'unknown',
  rendererPreference: 'webgl',
  deviceLost: false,
  longTaskHead: 0,
  longTaskHistory: Array.from({ length: LONG_TASK_HISTORY_SIZE }, () => ({
    at: 0, ms: 0, frameMs: 0, lagMs: 0, subsystem: 'unknown', scripts: [],
  })),
};

export function recordClientLongTask(ms, now = performance.now(), frameMs = ms, lagMs = 0, subsystem = 'frame', details = {}) {
  const value = Math.max(0, Number(ms) || 0);
  const idx = clientPerfStats.longTaskHead % LONG_TASK_HISTORY_SIZE;
  const entry = clientPerfStats.longTaskHistory[idx];
  entry.at = now;
  entry.ms = value;
  entry.frameMs = Math.max(0, Number(frameMs) || 0);
  entry.lagMs = Math.max(0, Number(lagMs) || 0);
  entry.subsystem = String(subsystem || 'frame');
  entry.scripts = Array.isArray(details.scripts) ? details.scripts.slice(0, 16) : [];
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
    this._renderScale = new AdaptiveRenderScale({ minScale: clientRuntimeProfile.tier === 'low' ? .7 : .8 });
    this._memorySampleBusy = false;
  }

  async init() {
    let rendererPreference = profileManager.get('graphics.renderer') === 'webgpu' && globalThis.navigator?.gpu
      ? 'webgpu' : 'webgl';
    try {
      if (sessionStorage.getItem('uo.renderer.recovery') === 'webgl') {
        rendererPreference = 'webgl'; sessionStorage.removeItem('uo.renderer.recovery');
      }
    } catch { /* hardened storage */ }
    const rendererOptions = {
      resizeTo: this.mountPoint,
      antialias: false,
      autoDensity: true,
      // Resolution=1 forces integer-pixel rendering. ClassicUO's
      // UltimaBatcher2D paints at native resolution; >1 caused our
      // 44×22 diamond sprites to bleed at chunk seams.
      resolution: 1,
      // The full browser surface is UI chrome; the actual ocean/world
      // backdrop is painted only inside Camera's masked viewport.
      backgroundColor: 0x070b10,
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
      preference: rendererPreference,
      roundPixels: true,
    };
    try { await this.app.init(rendererOptions); }
    catch (error) {
      if (rendererPreference !== 'webgpu') throw error;
      console.warn('[pixi] WebGPU initialization failed; using WebGL2', error);
      rendererPreference = 'webgl'; this.app = new Application();
      await this.app.init({ ...rendererOptions, preference: 'webgl' });
    }
    this.mountPoint.appendChild(this.app.canvas);
    // Renderer diagnostic — surfaces whether Pixi fell back from
    // WebGPU to WebGL2. `preference: 'webgpu'` is a hint; some
    // GPUs/browsers (older Chrome on Linux, Firefox without flag)
    // still return a WebGL2 renderer. Knowing which is in play
    // helps debug perf regressions and visual diffs vs CUO.
    try {
      const r = this.app.renderer;
      const type = r?.type === 1 ? 'WebGL' : (r?.type === 2 ? 'WebGPU' : 'unknown');
      clientPerfStats.renderer = type.toLowerCase();
      clientPerfStats.rendererPreference = rendererPreference;
      console.log(`[pixi] renderer=${type} resolution=${r?.resolution} roundPixels=${r?.roundPixels} (preference: ${rendererPreference})`);
      const device = r?.gpu?.device ?? r?.device;
      if (device?.lost?.then) device.lost.then((info) => {
        clientPerfStats.deviceLost = true;
        bus.emit('renderer:device-lost', { reason: info?.reason, message: info?.message });
        try { sessionStorage.setItem('uo.renderer.recovery', 'webgl'); } catch { /* storage unavailable */ }
        this.setStatus('GPU device lost — restarting with WebGL2…');
        setTimeout(() => globalThis.location?.reload?.(), 250);
      });
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

    // WebGL context loss is recoverable in browsers (GPU reset, laptop
    // sleep, driver switch). Pause simulation while Pixi rebuilds its
    // managed resources, then redraw the active scene on restoration.
    this._onContextLost = (event) => {
      event.preventDefault?.();
      this._contextLost = true;
      clientPerfStats.deviceLost = true;
      this.app.ticker.stop();
      this.setStatus('graphics context lost — restoring…');
      bus.emit('renderer:context-lost');
    };
    this._onContextRestored = () => {
      this._contextLost = false;
      this.scene?.resize(window.innerWidth, window.innerHeight);
      this.setStatus('idle');
      this.app.ticker.start();
      bus.emit('renderer:context-restored');
    };
    this.app.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    this.app.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    // Browser-observed long tasks cover image decoding, promise storms and
    // third-party work that the scene update/draw stopwatch cannot attribute.
    try {
      this._longTaskObserver = new globalThis.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const source = entry.attribution?.[0]?.name || 'browser';
          recordClientLongTask(entry.duration, entry.startTime, entry.duration, 0, `longtask:${source}`);
        }
      });
      this._longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch { this._longTaskObserver = null; }

    // LoAF entries include script attribution for the whole delayed render
    // update, which makes a client report actionable instead of just saying
    // that an anonymous 50 ms task happened.
    try {
      this._loafObserver = new globalThis.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const scripts = (entry.scripts ?? []).slice(0, 16).map((script) => ({
            source: String(script.sourceURL || script.sourceFunctionName || script.invoker || 'browser').slice(0, 160),
            duration: Math.max(0, Number(script.duration) || 0),
          }));
          recordClientLongTask(entry.duration, entry.startTime, entry.duration, 0, 'long-animation-frame', { scripts });
        }
      });
      this._loafObserver.observe({ type: 'long-animation-frame', buffered: true });
    } catch { this._loafObserver = null; }

    this._sampleClientMemory = async () => {
      if (this._memorySampleBusy || document.hidden) return;
      this._memorySampleBusy = true;
      try {
        const memory = performance.memory;
        if (memory) {
          clientPerfStats.heapUsedBytes = Number(memory.usedJSHeapSize) || 0;
          clientPerfStats.heapLimitBytes = Number(memory.jsHeapSizeLimit) || 0;
        }
        if (typeof performance.measureUserAgentSpecificMemory === 'function' && globalThis.crossOriginIsolated) {
          const measured = await performance.measureUserAgentSpecificMemory();
          clientPerfStats.measuredMemoryBytes = Number(measured?.bytes) || 0;
        }
        if (navigator.storage?.estimate) {
          const storage = await navigator.storage.estimate();
          clientPerfStats.storageUsageBytes = Number(storage.usage) || 0;
          clientPerfStats.storageQuotaBytes = Number(storage.quota) || 0;
        }
      } catch { /* optional privacy-restricted diagnostics */ }
      finally { this._memorySampleBusy = false; }
    };
    this._sampleClientMemory();
    this._memorySampleTimer = setInterval(this._sampleClientMemory, 30_000);

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
        clearTimeout(this._inactiveTrimTimer);
        this._inactiveTrimTimer = setTimeout(() => {
          if (document.hidden) bus.emit('assets:trim-inactive');
        }, clientRuntimeProfile.inactiveTrimMs);
      } else {
        clearTimeout(this._inactiveTrimTimer);
        this._inactiveTrimTimer = null;
        this.app.ticker.maxFPS = this._fpsCapBeforeHide;
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    // Single bound handler — registered once at init, never re-added on
    // scene swap. Earlier code created an arrow on every init() which
    // would have leaked when (rare) GameController instances were
    // recreated (e.g. tests). Keep the reference so destroy() can detach.
    this._onResize = () => {
      bus.emit('ui:viewport-resized', { width: window.innerWidth, height: window.innerHeight });
      this.scene?.resize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        const w = Math.round(rect?.width ?? 0);
        const h = Math.round(rect?.height ?? 0);
        if (w <= 0 || h <= 0 || (w === this._observedW && h === this._observedH)) return;
        this._observedW = w; this._observedH = h;
        bus.emit('ui:viewport-resized', { width: w, height: h });
        this.scene?.resize(window.innerWidth, window.innerHeight);
      });
      this._resizeObserver.observe(this.mountPoint);
    }
  }

  destroy() {
    clearInterval(this._memorySampleTimer);
    this._memorySampleTimer = null;
    this._longTaskObserver?.disconnect?.();
    this._longTaskObserver = null;
    this._loafObserver?.disconnect?.();
    this._loafObserver = null;
    this._resizeObserver?.disconnect?.();
    this._resizeObserver = null;
    if (this.app?.canvas) {
      this.app.canvas.removeEventListener('webglcontextlost', this._onContextLost, false);
      this.app.canvas.removeEventListener('webglcontextrestored', this._onContextRestored, false);
    }
    this._onContextLost = null;
    this._onContextRestored = null;
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
      const quality = clientPerformanceGovernor.observeFrame(frameMs, now);
      if (quality) {
        clientPerfStats.qualityLevel = quality.level;
        clientPerfStats.frameP50Ms = quality.p50Ms;
        clientPerfStats.frameP95Ms = quality.p95Ms;
        clientPerfStats.frameP99Ms = quality.p99Ms;
        if (quality.changed) bus.emit('performance:quality-changed', quality);
        this._renderScale.minScale = Math.max(.5, Math.min(1,
          Number(profileManager.get('graphics.dynamicResolutionMin')) || (clientRuntimeProfile.tier === 'low' ? .7 : .8)));
        const renderScale = profileManager.get('graphics.dynamicResolution') === false
          ? this._renderScale.observe('nominal', now)
          : this._renderScale.observe(quality.level, now);
        if (renderScale && this.app?.renderer) {
          try {
            this.app.renderer.resolution = renderScale.scale;
            this.app.renderer.resize(this.mountPoint.clientWidth || innerWidth, this.mountPoint.clientHeight || innerHeight);
            clientPerfStats.renderScale = renderScale.scale;
            bus.emit('performance:render-scale-changed', renderScale);
          } catch { /* backend may not allow live resolution changes */ }
        }
      }
    }
    clearTimeout(this._inactiveTrimTimer);
    this._inactiveTrimTimer = null;
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
    if (clientPerfStats.tickMs >= LONG_TASK_THRESHOLD_MS) {
      const subsystem = clientPerfStats.updateMs >= clientPerfStats.drawMs ? 'scene.update' : 'scene.draw';
      const latest = clientPerfStats.longTaskHistory[(clientPerfStats.longTaskHead - 1 + LONG_TASK_HISTORY_SIZE) % LONG_TASK_HISTORY_SIZE];
      if (latest?.at === now) latest.subsystem = subsystem;
    }
  }
}
