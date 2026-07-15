// Browser-side entry point. Mirrors ClassicUO's
// ClassicUO.Bootstrap/Program.cs — only its job is to (1) construct the
// GameController, (2) install the LoginScene, (3) hand control over to the
// Pixi ticker.
//
// Net handlers are registered once here so they survive scene swaps.

import { GameController } from './core/game-controller.js';
import { net } from './net/net-client.js';
import { registerHandlers } from './net/handlers.js';
import { bus } from './core/event-bus.js';
import { assets } from './assets/asset-manager.js';
import { startKeepAlive, stopKeepAlive } from './net/keep-alive.js';
import { systemCursor } from './managers/system-cursor.js';
import { world } from './world/world.js';

const mount = document.getElementById('app');
if (!mount) throw new Error('#app mount point missing');

// Loading splash — shown until the first interactive scene takes over.
// CUO has its own animated loader; we keep it minimal: brand text +
// a progress hint. The DOM node sits OVER the Pixi canvas, no Pixi
// dependency, so it's visible the millisecond the script runs.
const splash = document.createElement('div');
splash.id = 'uo-splash';
splash.style.cssText = `
  position:fixed; inset:0; z-index:9999;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  background:#0c1018; color:#fff0c0; font-family:'Times New Roman',serif;
  transition:opacity 0.4s ease;
`;
splash.innerHTML = `
  <div style="font-size:42px; letter-spacing:6px; margin-bottom:12px;">ULTIMA ONLINE</div>
  <div style="font-size:14px; letter-spacing:2px; color:#a89060;">UO-Node Shard</div>
  <div style="margin-top:36px; width:380px;">
    <div style="height:8px; background:#0c0c0c; border:1px solid #6e5520; border-radius:4px; overflow:hidden;">
      <div id="uo-splash-bar" style="height:100%; width:0%; background:linear-gradient(90deg,#a48830,#fff0c0); transition:width 0.2s ease;"></div>
    </div>
    <div id="uo-splash-status" style="margin-top:8px; font:11px Consolas,monospace; color:#7a8090; text-align:center; letter-spacing:1px;">BOOTING</div>
  </div>
`;
document.body.appendChild(splash);
const setSplash = (msg, percent) => {
  const s = splash.querySelector('#uo-splash-status');
  const b = splash.querySelector('#uo-splash-bar');
  if (s) s.textContent = msg;
  if (b && Number.isFinite(percent)) b.style.width = `${Math.max(0, Math.min(100, percent | 0))}%`;
};

const gc = new GameController(mount);
let worldServices = null;
let worldServicesPromise = null;
// LoginScene starts this preload when the user commits a character. That
// overlaps the final server handshake with module fetch/evaluation and keeps
// world-only managers off the initial login path.
gc.prepareWorld = () => {
  worldServicesPromise ??= Promise.all([
    assets.init({ facet: world.mapId }),
    import('./bootstrap-world.js'),
  ]).then(([, { installWorldServices }]) => {
      worldServices = installWorldServices(bus);
      return worldServices;
    });
  return worldServicesPromise;
};
setSplash('INITIALISING RENDERER', 5);
await gc.init();

// Pre-load static asset manifests + the hues palette texture. Atlas pages
// and map blocks are fetched lazily (on first use). Failures here are
// non-fatal — the renderer has placeholder fallbacks.
gc.setStatus('loading assets…');
setSplash('LOADING ATLASES', 15);
try {
  await assets.initLogin({
    onProgress: (pct, label) => {
      // pct is 0..1 within the asset loader; clamp into the 15-95 % band.
      const overall = 15 + Math.round(pct * 80);
      setSplash(label.toUpperCase(), overall);
    },
  });
  // Expose the login subset for character-creation preview. Full world
  // assets are prepared after the user commits a character.
  // runs before GameScene mounts and can't import assets directly
  // without a circular reference).
  try {
    globalThis.__assets = assets;
    if (typeof window !== 'undefined') window.__assetsBase = '/assets';
  } catch { /* SSR */ }
}
catch (e) { console.warn('[main] asset init failed', e); }
gc.setStatus('idle');
setSplash('CONNECTING TO SHARD', 95);

// One-time handler registration. The registerHandlers() table just sets
// entries on net._handlers (a Map) — calling it again is harmless but the
// single-call here keeps things obvious.
registerHandlers(net);

// Replace the OS pointer with the UO sprite. Marcin asked for the
// classic art.mul cursors instead of the platform arrow. Auto-polls
// the atlas image and surfaces the cursor once `cursorsImage`
// finishes loading; up to that moment the OS pointer remains.
systemCursor.install();

// Surface unhandled opcodes during development so we know which
// FAZA-1+ opcodes are landing before we wire decoders.
bus.on('net:unhandled', ({ opcode }) => {
  if (import.meta.env.DEV) {
    console.debug(`[net] unhandled opcode 0x${opcode.toString(16).padStart(2, '0')}`);
  }
});

// Start the 20s keep-alive once the socket is open; stop on close.
bus.on('net:open',  () => startKeepAlive());
bus.on('net:close', (info) => {
  stopKeepAlive();
  // Surface the close reason — the previous reload showed the game scene
  // briefly then bounced back to login, which means the socket got closed
  // somewhere between LoginConfirm and the first frame. Log code + reason
  // so we can pinpoint the culprit (server crash, kicked, idle timeout).
  console.warn('[net] socket closed', info);
});

// OPT WIN#2 (2026-05-07): register service worker so atlas PNG / .bin /
// .json get cached forever (content-hashed URLs invalidate on re-deploy).
// Skip in dev — vite serves through its dev server and SW would mask
// hot-reload changes. `import.meta.env.PROD` is true on `vite build`.
// Defer SW registration past initial paint so the registration handshake
// + script fetch don't compete with critical asset downloads. `load`
// fires after first frame, then we wait one rAF more before kicking it
// off.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const registerSw = () => {
    requestAnimationFrame(() => {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.warn('[sw] registration failed:', e?.message ?? e);
      });
    });
  };
  if (document.readyState === 'complete') registerSw();
  else window.addEventListener('load', registerSw, { once: true });
}

const { LoginScene } = await import('./scenes/login-scene.js');
await gc.setScene(new LoginScene(gc));

// Fade the splash out once the LoginScene is up. Keep it in DOM for
// 600ms — enough for the fade to complete — then remove entirely so
// pointer events fall through to the game.
splash.style.opacity = '0';
setTimeout(() => splash.remove(), 600);

// expose for ad-hoc debugging in DevTools
if (import.meta.env.DEV || new URLSearchParams(globalThis.location?.search ?? '').has('runtimeAudit')) {
  /** @type {any} */ (globalThis).__uo = {
    gc, net, bus,
    get camera() { return worldServices?.camera ?? null; },
    get diagnostics() { return worldServices?.diagnosticsManager ?? null; },
  };
}
