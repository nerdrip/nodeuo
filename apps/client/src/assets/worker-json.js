// Wrapper around `json-worker.js`. Spins up a single dedicated worker
// at first call, multiplexes `fetchJson(url)` requests over postMessage
// with auto-incrementing ids, returns the parsed JSON.
//
// Falls back to a plain main-thread fetch+parse if Workers aren't
// available (test harness via jsdom sometimes misses Worker support).
//
// This module is deliberately optional — only callers that know the
// payload is heavy (tiledata, animdata, multis) use it. Small JSON
// reuses the regular fetchJson path.

let _worker = null;
let _nextId = 1;
const _pending = new Map();

function _ensureWorker() {
  if (_worker) return _worker;
  if (typeof Worker === 'undefined') return null;
  try {
    // Vite handles `new URL('./*.js', import.meta.url)` + `type:'module'`
    // workers natively — the build output has the worker chunk-split.
    _worker = new Worker(new URL('./json-worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const m = e.data;
      const cb = _pending.get(m.id);
      if (!cb) return;
      _pending.delete(m.id);
      if (m.ok) cb.resolve(m.data ?? null);
      else cb.reject(new Error(m.error ?? 'worker failed'));
    };
    _worker.onerror = (err) => {
      console.warn('[worker-json] error:', err?.message ?? err);
    };
  } catch (e) {
    console.warn('[worker-json] failed to spawn:', e?.message ?? e);
    _worker = null;
  }
  return _worker;
}

/**
 * Fetch + parse JSON off the main thread.
 *
 * Returns the parsed JSON (or null on 404 / other non-fatal failure).
 * Throws on hard network failure with no fallback.
 */
export async function fetchJsonInWorker(url, opts = {}) {
  const w = _ensureWorker();
  if (!w) {
    // Fallback path — main thread.
    const r = await fetch(url, { headers: opts.headers ?? {} });
    if (!r.ok) return null;
    if (opts.sha256 || Number.isFinite(opts.bytes)) {
      const buffer = await r.arrayBuffer();
      if (Number.isFinite(opts.bytes) && buffer.byteLength !== opts.bytes) {
        throw new Error(`size mismatch: expected ${opts.bytes}, received ${buffer.byteLength}`);
      }
      if (opts.sha256) {
        if (!globalThis.crypto?.subtle) throw new Error('WebCrypto unavailable for asset integrity check');
        const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
        const actual = [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, '0')).join('');
        if (actual !== String(opts.sha256).toLowerCase()) throw new Error('SHA-256 mismatch');
      }
      return JSON.parse(new TextDecoder().decode(buffer));
    }
    return r.json();
  }
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, url, etag: opts.etag, lastModified: opts.lastModified,
      sha256: opts.sha256, bytes: opts.bytes });
  });
}

/** Tear down the worker (test cleanup). */
export function shutdownJsonWorker() {
  try { _worker?.terminate(); } catch { /* ignore */ }
  _worker = null;
  _pending.clear();
}
