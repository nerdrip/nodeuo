// NodeUO asset service worker.
//
// The cache is a tiny three-generation state machine: staging is warmed and
// verified before activation, active serves the current release, and previous
// remains available for an instant rollback. Classic UO traffic never passes
// through this worker; this is strictly a browser asset optimization.

// Patched by packages/extractor/extract.js after every extraction.
const CACHE_VERSION = 'uo-assets-v1784070731622';
const META_CACHE = 'nodeuo-assets-meta-v1';
const META_URL = '/__nodeuo_asset_cache_state__';
const CACHE_PREFIX = 'uo-assets-';
const ASSET_PATH = /^\/assets\/.+\.(png|json|bin|mp3|ogg|wav|ktx2)$/;
const MUTABLE_ASSET_PATH = /^\/assets\/(?:overrides\/.*\.png|(?:mobiles-atlas-index|asset-overrides|patches|tiledata|hues|animdata|multi|radarcol|cliloc|sounds|music|cursors)\.json)$/;
let statePromise = null;

function cleanGeneration(value, fallback = CACHE_VERSION) {
  const text = String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
  return text || fallback;
}
function cacheName(generation) {
  const clean = cleanGeneration(generation);
  return clean.startsWith(CACHE_PREFIX) ? clean : `${CACHE_PREFIX}${clean}`;
}
async function readState() {
  if (statePromise) return statePromise;
  statePromise = (async () => {
    try {
      const cache = await caches.open(META_CACHE);
      const response = await cache.match(META_URL);
      if (response) return await response.json();
    } catch { /* initialize below */ }
    return { schema: 1, active: CACHE_VERSION, previous: null, staging: null, updatedAt: Date.now() };
  })();
  return statePromise;
}
async function writeState(next) {
  const value = { schema: 1, active: cleanGeneration(next.active),
    previous: next.previous ? cleanGeneration(next.previous) : null,
    staging: next.staging ? cleanGeneration(next.staging) : null, updatedAt: Date.now() };
  const cache = await caches.open(META_CACHE);
  await cache.put(META_URL, new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }));
  statePromise = Promise.resolve(value);
  return value;
}
async function broadcast(type, payload = {}) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    client.postMessage({ type, ...payload });
  }
}
async function cleanupCaches(state) {
  const keep = new Set([META_CACHE, cacheName(state.active),
    state.previous && cacheName(state.previous), state.staging && cacheName(state.staging)].filter(Boolean));
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && !keep.has(name)) await caches.delete(name);
  }
  try {
    const estimate = await self.navigator?.storage?.estimate?.();
    const pressure = estimate?.quota ? Number(estimate.usage) / Number(estimate.quota) : 0;
    if (pressure > 0.85 && state.staging) {
      await caches.delete(cacheName(state.staging)); state = await writeState({ ...state, staging: null });
    }
    if (pressure > 0.94 && state.previous) {
      await caches.delete(cacheName(state.previous)); state = await writeState({ ...state, previous: null });
    }
    return { state, pressure, usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0 };
  } catch { return { state, pressure: 0, usage: 0, quota: 0 }; }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const state = await readState();
    await caches.open(cacheName(state.active));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    let state = await readState();
    if (state.active !== CACHE_VERSION) state = await writeState({
      active: CACHE_VERSION, previous: state.active, staging: null,
    });
    await caches.open(cacheName(state.active));
    await cleanupCaches(state);
    await self.clients.claim();
  })());
});

async function warmGeneration(generation, files = []) {
  const state = await readState();
  const clean = cleanGeneration(generation);
  const target = await caches.open(cacheName(clean));
  await writeState({ ...state, staging: clean });
  const urls = [...new Set(files.map((entry) => typeof entry === 'string' ? entry : entry?.name)
    .filter(Boolean).map((name) => name.startsWith('/assets/') ? name : `/assets/${name}`))].slice(0, 4096);
  let next = 0, completed = 0, failed = 0, bytes = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes += Number(response.headers.get('content-length')) || 0;
        await target.put(url, response);
      } catch { failed++; }
      completed++;
      if (completed === urls.length || completed % 16 === 0) {
        await broadcast('nodeuo:cache-progress', { generation: clean, completed, total: urls.length, failed, bytes });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, urls.length)) }, worker));
  return { ok: failed === 0, operation: 'stage', generation: clean, completed, failed, bytes };
}

self.addEventListener('message', (event) => {
  const message = event.data ?? {};
  if (message.type !== 'nodeuo:asset-cache') return;
  event.waitUntil((async () => {
    let state = await readState();
    let result;
    if (message.operation === 'stage') {
      result = await warmGeneration(message.generation, message.files);
      state = await readState();
    } else if (message.operation === 'activate') {
      const generation = cleanGeneration(message.generation);
      await caches.open(cacheName(generation));
      state = await writeState({ active: generation,
        previous: state.active === generation ? state.previous : state.active, staging: null });
      result = { ok: true, operation: 'activate', generation };
    } else if (message.operation === 'rollback') {
      if (!state.previous) result = { ok: false, error: 'no previous asset generation' };
      else {
        const active = state.active;
        state = await writeState({ active: state.previous, previous: active, staging: null });
        result = { ok: true, operation: 'rollback', generation: state.active };
      }
    } else if (message.operation === 'status') result = { ok: true, state };
    else result = { ok: false, error: 'unknown cache operation' };
    const cleanup = await cleanupCaches(state);
    await broadcast('nodeuo:cache-state', { requestId: message.requestId, result, ...cleanup });
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin || !ASSET_PATH.test(url.pathname)) return;
  event.respondWith((async () => {
    const state = await readState();
    const active = await caches.open(cacheName(state.active));
    if (MUTABLE_ASSET_PATH.test(url.pathname)) {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh.ok && fresh.status === 200) await active.put(request, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return (await active.match(request))
          ?? (state.previous ? await (await caches.open(cacheName(state.previous))).match(request) : undefined)
          ?? Response.error();
      }
    }
    const hit = await active.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok && response.status === 200) await active.put(request, response.clone()).catch(() => {});
    return response;
  })());
});
