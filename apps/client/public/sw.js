// Service Worker — cache-first for extracted /assets/*. Atlas pages and JSON
// manifests share one extractor-generated cache generation, so their geometry
// and pixels can never drift across deployments. Heavy JSON is parsed in a
// worker; retaining its raw response here avoids downloading the 50+ MB mobile
// catalogue again on every page load.
//
// Strategy:
//   - /assets/*.png/json → cache-first, network fallback, store on first miss
//   - /assets/*.bin  → cache-first (map / staidx / sounds bin)
//   - /assets/*.mp3  → cache-first (music tracks)
//   - everything else → network passthrough (HTML, JS, JSON, sockets)
//
// On install we pre-warm the cache name; assets are populated on
// first request (lazy). Activate clears stale cache versions so a
// re-extracted atlas doesn't serve a stale page after `pnpm extract`.

// CACHE_VERSION is patched by `packages/extractor/extract.js` after every
// run so a re-extraction automatically invalidates the disk cache —
// otherwise the SW kept serving stale PNGs against a fresh JSON
// manifest, producing visibly wrong sprite frames (mobile animations
// drawing garbage pixels because the per-frame (u, v, w, h) rect now
// pointed into an OLD atlas page on disk). Format:
//   uo-assets-<timestamp> — millis since epoch, monotonically increasing.
const CACHE_VERSION = 'uo-assets-v1784070731622';
const ASSET_PATH    = /^\/assets\/.+\.(png|json|bin|mp3|ktx2)$/;

self.addEventListener('install', (e) => {
  // Skip-waiting so a fresh worker doesn't sit pending until every
  // tab closes. The next page load picks the new SW immediately.
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_VERSION));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop any cache that doesn't match the current version — keeps
    // the disk footprint bounded across re-extract cycles.
    for (const k of await caches.keys()) {
      if (k !== CACHE_VERSION) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // CacheStorage matches by URL and can return a cached HTTP 200 body for a
  // later Range request. Let the browser/network own byte ranges so streamed
  // map blocks never accidentally inflate back into the complete 90 MB file.
  if (req.headers.has('range')) return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (!ASSET_PATH.test(url.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const hit   = await cache.match(req);
    if (hit) return hit;
    // Offline + first-request propagates the fetch failure so the
    // assets-manager candidate chain can fall through to its placeholder.
    const res = await fetch(req);
    if (res && res.ok && res.status === 200) {
      try { await cache.put(req, res.clone()); }
      catch { /* quota / opaque response — cache is best-effort */ }
    }
    return res;
  })());
});
