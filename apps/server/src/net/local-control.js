// Small process-control route on the game HTTP listener. The Electron launcher
// can request the existing graceful shutdown path even when admin UI is off.

import { createHash, timingSafeEqual } from 'node:crypto';

function isLoopback(address) {
  const peer = String(address ?? '').toLowerCase();
  return peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
}

function isLocalPeer(socket) {
  // A launcher can self-connect through the shard's explicit LAN bind.
  // TCP reports the same local and remote interface address in that case.
  return isLoopback(socket?.remoteAddress)
    || Boolean(socket?.remoteAddress && socket.remoteAddress === socket.localAddress);
}

export function createLocalControlHandler({ token, onShutdown }) {
  const enabled = typeof token === 'string' && token.length > 0;
  const expected = enabled ? createHash('sha256').update(token).digest() : null;

  return (req, res) => {
    if (req.url !== '/internal/shutdown') return false;
    if (!enabled) {
      res.writeHead(404).end();
      return true;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return true;
    }
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' && /^Bearer (.+)$/i.exec(authorization);
    const supplied = createHash('sha256').update(match ? match[1] : '').digest();
    if (!isLocalPeer(req.socket) || !timingSafeEqual(expected, supplied)) {
      res.writeHead(403).end();
      return true;
    }
    res.writeHead(202, { 'Cache-Control': 'no-store', Connection: 'close' }).end();
    setImmediate(onShutdown);
    return true;
  };
}
