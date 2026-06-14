// Periodic 0x73 Ping. Mirrors ClassicUO Network/NetClient.cs ping. Without
// it, idle TCP connections get dropped by some intermediate routers / load
// balancers within 60-120 s. We send a minimal-cost ping every 20 s.

import { net } from './net-client.js';
import { buildPing } from './outgoing.js';

const INTERVAL_MS = 20_000;

let _seq = 0;
let _timer = null;

export function startKeepAlive() {
  stopKeepAlive();
  _timer = setInterval(() => {
    if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
    net.send(buildPing(_seq));
    _seq = (_seq + 1) & 0xff;
  }, INTERVAL_MS);
}

export function stopKeepAlive() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
