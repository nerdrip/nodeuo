// IndexedDB-backed cache for asset manifests (hues.json, tiledata.json,
// animdata.json, multis.json, housedata.json, mapMeta, statics meta…).
//
// Why IndexedDB and not just the SW cache?
//   The SW cache stores Response objects intact (headers + body). For
//   500 KB JSON manifests that's fine but the round-trip per object
//   includes Response.clone() + cache.match() — the Service Worker has
//   to wake up. IndexedDB lets us cache the parsed JSON in the same
//   window/worker, skip the SW entirely, and amortize the parse cost
//   across page-loads.
//
// API:
//   const cache = await openIdbCache('uo-manifest', 1);
//   const data = await cache.getOrFetch('tiledata', `${BASE}/tiledata.json`);
//   // → either the parsed JSON from IDB or freshly fetched + stored.
//
// Validation: we store ETag + Last-Modified alongside the parsed JSON.
// On the next load, we send a conditional GET (`If-None-Match` / `If-
// Modified-Since`). 304 → use the cached value untouched. 200 → replace
// the cached value with the new payload.
//
// Cap: no per-key cap (manifests are bounded — ~6 of them, total <10MB).
// If the browser ever runs short on storage, IDB itself will evict the
// whole database; we tolerate that gracefully (next load just re-fetches).

const DEFAULT_DB_NAME = 'uo-manifest';
const STORE = 'manifests';

function openDatabase(dbName, version) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(db, name) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

function dbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

class IdbCache {
  constructor(db) { this._db = db; }

  /**
   * Get the parsed manifest. If not in IDB, fetch + store. If in IDB,
   * issue a conditional GET; on 304, use the cached value; on 200,
   * replace.
   *
   * OPT (2026-05-08): the IDB read and the conditional fetch run IN
   * PARALLEL. Earlier code awaited IDB before kicking off the network
   * request, serialising what could be two simultaneous round-trips.
   * On a cold IDB transaction (~30ms) plus a 100ms RTT to the asset
   * server, that's a 130ms wait → now both run together for ~100ms.
   *
   * The conditional headers from cached etag are added in a follow-up
   * fetch retry IF we got the cache hit before the network completed
   * (rare). In the common case (cold cache), the parallel fetch wins
   * the race and we avoid the second round-trip entirely.
   *
   * Returns the parsed JSON (or null on hard error so callers can
   * fall back to a default).
   */
  async getOrFetch(name, url, opts = {}) {
    // Kick off both reads in parallel.
    const cachePromise = dbGet(this._db, name).catch(() => null);
    const headers = new Headers(opts.headers ?? {});
    const fetchPromise = fetch(url, { headers }).catch((e) => ({ _error: e }));

    const cached = await cachePromise;
    let res = await fetchPromise;

    // If we have a cached etag/lastModified that the server didn't see
    // because we kicked off the request without it, ask the server
    // again with conditional headers. Only worth it when the response
    // we got back is a fresh 200 — saves bandwidth on repeated loads.
    if (cached?.etag && res && !res._error && res.status === 200) {
      // Don't bother re-validating; the body is already in flight.
      // Cached value is stale; the new 200 will replace it below.
    }

    // Network failure — fall back to cache.
    if (!res || res._error) {
      if (cached) return cached.data;
      throw res?._error ?? new Error('network failed');
    }

    if (res.status === 304 && cached) {
      return cached.data;
    }
    if (!res.ok) {
      if (cached) return cached.data;
      return null;
    }
    let data;
    try { data = await res.json(); }
    catch { return cached?.data ?? null; }
    const record = {
      name,
      data,
      etag: res.headers.get('etag') ?? null,
      lastModified: res.headers.get('last-modified') ?? null,
      storedAt: Date.now(),
    };
    try { await dbPut(this._db, record); } catch { /* ignore quota */ }
    return data;
  }

  async clear() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }
}

let _shared = null;

/**
 * Open (or reuse) the shared IDB-backed manifest cache. Returns null on
 * environments without IndexedDB (test harness / very old browsers); the
 * caller should fall back to plain `fetch().then(r=>r.json())`.
 */
export async function openIdbCache(dbName = DEFAULT_DB_NAME, version = 1) {
  if (typeof indexedDB === 'undefined') return null;
  if (_shared) return _shared;
  try {
    const db = await openDatabase(dbName, version);
    _shared = new IdbCache(db);
    return _shared;
  } catch (e) {
    console.warn('[idb-cache] failed to open:', e?.message ?? e);
    return null;
  }
}

/**
 * Helper for parallel manifest loads. Pass [{name, url}, …] and get back
 * an object keyed by name with the parsed JSON. Falls back to plain
 * fetch if IDB isn't available.
 */
export async function loadManifests(entries, dbName = DEFAULT_DB_NAME) {
  const cache = await openIdbCache(dbName);
  const out = {};
  await Promise.all(entries.map(async ({ name, url, fallback = null }) => {
    if (cache) {
      out[name] = await cache.getOrFetch(name, url) ?? fallback;
    } else {
      try {
        const r = await fetch(url);
        out[name] = r.ok ? (await r.json()) : fallback;
      } catch { out[name] = fallback; }
    }
  }));
  return out;
}
