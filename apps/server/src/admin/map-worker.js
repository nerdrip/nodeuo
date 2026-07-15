'use strict';

let active = null;

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === 'json') {
    try {
      const response = await fetch(message.url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${message.url}: HTTP ${response.status}`);
      const text = await response.text();
      const data = JSON.parse(text);
      self.postMessage({ type: 'json-loaded', id: message.id, data, bytes: text.length });
    } catch (error) {
      self.postMessage({ type: 'error', id: message.id, error: error?.message || String(error) });
    }
    return;
  }
  if (message.type === 'cancel') {
    if (!active || message.id === active.id) active?.controller.abort();
    return;
  }
  if (message.type !== 'load') return;
  active?.controller.abort();
  const controller = new AbortController();
  active = { id: message.id, controller };
  const started = performance.now();
  try {
    const query = new URLSearchParams(message.params).toString();
    const fetchStarted = performance.now();
    const responses = await Promise.all([
      fetch(`/api/map/slice?${query}`, { credentials: 'same-origin', signal: controller.signal }),
      fetch(`/api/statics/slice?${query}`, { credentials: 'same-origin', signal: controller.signal }),
    ]);
    if (responses.some((response) => !response.ok)) {
      throw new Error(`chunk request failed (${responses.map((r) => r.status).join('/')})`);
    }
    const text = await Promise.all(responses.map((response) => response.text()));
    const fetchedAt = performance.now();
    // JSON parsing and cell indexing stay off the UI thread. The index is
    // compact diagnostic metadata; cells themselves retain wire order so the
    // renderer can apply its canonical depth sort.
    const [map, statics] = text.map((value) => JSON.parse(value));
    let staticCount = 0;
    const pages = new Set();
    for (const stack of Object.values(statics.cells || {})) {
      staticCount += stack.length;
      for (const entry of stack) pages.add((entry.tileId | 0) >>> 10);
    }
    const decodedAt = performance.now();
    self.postMessage({
      type: 'loaded', id: message.id, map, statics,
      metrics: {
        fetchMs: Number((fetchedAt - fetchStarted).toFixed(2)),
        decodeIndexMs: Number((decodedAt - fetchedAt).toFixed(2)),
        totalMs: Number((decodedAt - started).toFixed(2)),
        landTiles: map.tiles?.length ?? 0,
        staticCount,
        pageBuckets: pages.size,
        bytes: text[0].length + text[1].length,
      },
    });
  } catch (error) {
    if (error?.name !== 'AbortError') self.postMessage({ type: 'error', id: message.id, error: error?.message || String(error) });
  } finally {
    if (active?.id === message.id) active = null;
  }
};
