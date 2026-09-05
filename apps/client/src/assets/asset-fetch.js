import { openIdbCache } from './idb-cache.js';

let _idbCachePromise = null;

export function _idbCache() {
  if (!_idbCachePromise) _idbCachePromise = openIdbCache().catch(() => null);
  return _idbCachePromise;
}

// Manifests we route through the JSON worker — the biggest payloads
// whose parse cost would otherwise spike the main thread. Smaller
// JSON manifests stay on the IDB-cache path where the parse cost is
// negligible. Names match the trailing path component.
export const HEAVY_MANIFESTS = new Set([
  'tiledata.json',     // ~3-4 MB parsed in ~80ms
  'animdata.json',     // ~1-2 MB
  'multi.json',        // ~500 KB
  'cliloc.json',       // ~2 MB
  'mobiles-atlas.json', // ~53 MB; parsing this on the main thread freezes world entry
]);

export function isHeavyManifest(name) {
  return HEAVY_MANIFESTS.has(name)
    || /^mobiles-atlas-bodies-[a-f0-9-]+\.json$/i.test(name);
}

export async function fetchBinary(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  const type = String(r.headers?.get?.('content-type') ?? '').toLowerCase();
  // Vite and some reverse proxies answer an unknown asset path with the
  // HTML application shell. Treating that as map.bin creates valid-looking
  // DataViews full of random terrain until a later out-of-bounds read.
  if (type.startsWith('text/') || type.includes('html') || type.includes('json')) {
    throw new Error(`${url} → unexpected content-type ${type || '(missing)'}`);
  }
  return r.arrayBuffer();
}

export async function fetchBinaryRange(url, start, length) {
  const end = start + length - 1;
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error(`${url} [${start}-${end}] → HTTP ${r.status}`);
  const type = String(r.headers?.get?.('content-type') ?? '').toLowerCase();
  if (type.startsWith('text/') || type.includes('html') || type.includes('json')) {
    throw new Error(`${url} → unexpected content-type ${type || '(missing)'}`);
  }
  return { status: r.status, buffer: await r.arrayBuffer() };
}

export async function fetchJson(url) {
  const name = url.split('/').pop() ?? url;
  // Heavy manifests bypass IDB on first run and go through the worker
  // for off-thread parsing. Subsequent loads still warm from IDB via
  // the regular path (the worker is only worth its setup cost for
  // genuinely large payloads).
  if (isHeavyManifest(name)) {
    try {
      const { fetchJsonInWorker } = await import('./worker-json.js');
      const data = await fetchJsonInWorker(url);
      if (data != null) return data;
    } catch (e) {
      console.warn('[assets] worker fetch failed for', name, e?.message ?? e);
      // fall through to IDB path
    }
  }
  const c = await _idbCache();
  if (c) {
    const data = await c.getOrFetch(name, url);
    if (data == null) throw new Error(`${url} → empty`);
    return data;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

/** Fetch, hash and parse a content-addressed JSON shard off the main thread. */
export async function fetchJsonVerified(url, { sha256, bytes } = {}) {
  const { fetchJsonInWorker } = await import('./worker-json.js');
  const data = await fetchJsonInWorker(url, { sha256, bytes });
  if (data == null) throw new Error(`${url} → empty`);
  return data;
}
export async function fetchJsonOptional(url) {
  try { return await fetchJson(url); }
  catch { return null; }
}
