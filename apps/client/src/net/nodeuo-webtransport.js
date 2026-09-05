import { bus } from '../core/event-bus.js';

function timeout(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('WebTransport upgrade timed out')), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** Optional H3 datagram sidecar. The reliable UO stream always stays on WS. */
export function installNodeUOWebTransport(net) {
  let transport = null;
  let generation = 0;
  const close = () => {
    generation++;
    try { transport?.close?.({ closeCode: 0, reason: 'session reset' }); } catch { /* closed */ }
    transport = null;
    net.nodeUOWebTransport = null;
  };
  const reset = bus.on('net:session-reset', close);
  const offer = bus.on('nodeuo:transport-upgrade', async (payload) => {
    close();
    if (payload?.optional !== true || payload?.mode !== 'webtransport-h3'
        || typeof globalThis.WebTransport !== 'function') return;
    let endpoint;
    let token = '';
    try {
      endpoint = new URL(payload.url, globalThis.location?.href);
      if (endpoint.protocol !== 'https:') return;
      token = sessionStorage.getItem('nodeuo.resume') ?? '';
    } catch { return; }
    const expectedGeneration = generation;
    try {
      const candidate = new globalThis.WebTransport(endpoint.href);
      await timeout(candidate.ready, 3000);
      if (generation !== expectedGeneration) { candidate.close(); return; }
      if (token) {
        const control = await timeout(candidate.createBidirectionalStream(), 1000);
        const writer = control.writable.getWriter();
        await timeout(writer.write(new TextEncoder().encode(`${JSON.stringify({ schema: 1, token })}\n`)), 1000);
        await writer.close();
      }
      transport = candidate;
      net.nodeUOWebTransport = candidate;
      bus.emit('nodeuo:transport-ready', { mode: payload.mode, url: endpoint.origin });
      const reader = candidate.datagrams.readable.getReader();
      while (generation === expectedGeneration) {
        const { value, done } = await reader.read();
        if (done) break;
        net.receiveNodeUODatagram?.(value);
      }
    } catch (error) {
      if (generation === expectedGeneration) bus.emit('nodeuo:transport-fallback', {
        fallback: 'websocket', reason: String(error?.message ?? error),
      });
    }
  });
  return () => { close(); reset(); offer(); };
}
