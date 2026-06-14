// JSON parsing worker — offloads heavy `JSON.parse()` calls (tiledata,
// animdata, multis) off the main thread so first-paint isn't blocked
// by a 200ms+ parse spike.
//
// Protocol:
//   main → worker: { id, url, etag?, lastModified? }
//   worker → main: { id, ok:true, data, etag, lastModified }
//                  | { id, ok:false, error }
//
// The worker fetches the URL itself (CORS allowed for same-origin),
// streams the body, calls JSON.parse off-thread, and posts the parsed
// object back via structured clone. Pixi atlases (PNG) stay on the
// main thread because the browser native PNG decoder already runs
// off-thread internally.

self.onmessage = async (e) => {
  const req = e.data;
  if (!req || typeof req !== 'object' || !req.url) return;
  const { id, url, etag, lastModified } = req;
  try {
    const headers = new Headers();
    if (etag) headers.set('If-None-Match', etag);
    if (lastModified) headers.set('If-Modified-Since', lastModified);
    const res = await fetch(url, { headers });
    if (res.status === 304) {
      self.postMessage({ id, ok: true, notModified: true });
      return;
    }
    if (!res.ok) {
      self.postMessage({ id, ok: false, error: `status ${res.status}` });
      return;
    }
    // Stream the body as text first so we have full control over the
    // parse step (JSON.parse can throw for malformed responses; we
    // surface the error to the caller without crashing the worker).
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (err) {
      self.postMessage({ id, ok: false, error: `parse: ${err?.message ?? err}` });
      return;
    }
    self.postMessage({
      id, ok: true, data,
      etag: res.headers.get('etag') ?? null,
      lastModified: res.headers.get('last-modified') ?? null,
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
