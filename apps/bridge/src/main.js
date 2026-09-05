// WebSocket ↔ TCP bridge.
//
// Browsers cannot open raw TCP sockets (security), so connecting our browser
// client to a classic ServUO / RunUO / OSI-protocol server requires a small
// local proxy: the client opens a WebSocket to this bridge, the bridge opens
// a raw TCP socket to the real server, and bytes flow through unchanged in
// both directions. The wire format is byte-identical (Huffman frames stay
// compressed end-to-end), so neither side notices the bridge exists.
//
// Each WS upgrade carries the desired TCP target as `?target=HOST:PORT` in
// the URL query string, so a single bridge process can serve multiple game
// servers without restart. Targets are validated against an allowlist if one
// is configured (UO_BRIDGE_ALLOW), otherwise any host:port is allowed — the
// default is open since the typical use case is a developer running this on
// localhost.
//
// Env vars:
//   UO_BRIDGE_HOST     bind interface (default 127.0.0.1 — local-only)
//   UO_BRIDGE_PORT     listen port    (default 2595 — ServUO often binds
//                      2593..2594, so we sit one above to avoid EADDRINUSE
//                      when running both side-by-side on the same box)
//   UO_BRIDGE_PATH     ws path        (default /bridge)
//   UO_BRIDGE_ALLOW    optional comma-separated allowlist of host:port pairs
//                      (e.g. "uoshard.example:2593,127.0.0.1:2593"). When
//                      set, requests for any other target are refused with
//                      403. When empty, all targets are accepted.
//   UO_BRIDGE_DEFAULT  fallback target when client doesn't pass ?target=...
//                      (host:port). Useful if you want to dedicate the bridge
//                      to one shard.
//   UO_BRIDGE_DEBUG    when "1", dump first bytes of every decompressed
//                      server→client chunk and every ws→tcp packet. Use this
//                      to confirm what's actually on the wire when the client
//                      reports framing drift.
//   UO_BRIDGE_DEBUG_BYTES  how many bytes of each chunk to dump (default 64).
//   UO_BRIDGE_WORKERS  supervised worker count (default 1; protocol unchanged).
//   UO_BRIDGE_CONNECT_TIMEOUT_MS  target TCP connect timeout (default 10000).

import http from 'node:http';
import net from 'node:net';
import cluster from 'node:cluster';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { UOHuffmanStreamDecoder } from '@uo/protocol';

const BRIDGE_WORKERS = Math.max(1, Math.min(32, Number(process.env.UO_BRIDGE_WORKERS ?? 1) | 0));
if (cluster.isPrimary && BRIDGE_WORKERS > 1) {
  let stopping = false;
  for (let index = 0; index < Math.min(BRIDGE_WORKERS, os.availableParallelism?.() ?? os.cpus().length); index++) cluster.fork();
  cluster.on('exit', () => { if (!stopping) cluster.fork(); });
  const stopCluster = () => {
    if (stopping) return;
    stopping = true;
    cluster.disconnect(() => process.exit(0));
    const timer = setTimeout(() => process.exit(1), 5000); timer.unref?.();
  };
  process.on('SIGINT', stopCluster);
  process.on('SIGTERM', stopCluster);
  await new Promise(() => {});
}

const HOST = process.env.UO_BRIDGE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.UO_BRIDGE_PORT ?? 2595);
const PATH = process.env.UO_BRIDGE_PATH ?? '/bridge';
const DEFAULT_TARGET = process.env.UO_BRIDGE_DEFAULT ?? '';
const ALLOWLIST = (process.env.UO_BRIDGE_ALLOW ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Wire-level debug: when set, log the first bytes of each decompressed chunk
// from server→client. Used to diagnose framing drift. Off by default — noisy.
// Accepts both env var (UO_BRIDGE_DEBUG=1) and CLI flag (--debug) so it works
// the same in bash, cmd and PowerShell without env-var-syntax gymnastics.
const argv = process.argv.slice(2);
const cliDebug = argv.includes('--debug');
const cliBytesArg = argv.find((a) => a.startsWith('--debug-bytes='));
const DEBUG = cliDebug || process.env.UO_BRIDGE_DEBUG === '1';
const DEBUG_BYTES = Number(
  cliBytesArg ? cliBytesArg.split('=')[1] : (process.env.UO_BRIDGE_DEBUG_BYTES ?? 64),
);
const MAX_WS_PAYLOAD = Math.max(64 * 1024, Number(process.env.UO_BRIDGE_MAX_PAYLOAD ?? 256 * 1024));
const MAX_PRECONNECT_BYTES = Math.max(64 * 1024, Number(process.env.UO_BRIDGE_PRECONNECT_BYTES ?? 512 * 1024));
const WS_SOFT_PENDING_BYTES = Math.max(64 * 1024, Number(process.env.UO_BRIDGE_WS_SOFT_BYTES ?? 512 * 1024));
const WS_HARD_PENDING_BYTES = Math.max(WS_SOFT_PENDING_BYTES, Number(process.env.UO_BRIDGE_WS_HARD_BYTES ?? 2 * 1024 * 1024));
const TCP_CONNECT_TIMEOUT_MS = Math.max(1000, Math.min(60_000, Number(process.env.UO_BRIDGE_CONNECT_TIMEOUT_MS ?? 10_000)));

let nextId = 1;
const bridgeStats = {
  opened: 0, closed: 0, active: 0, rejected: 0,
  wsToTcpBytes: 0, tcpToWsBytes: 0, decodedBytes: 0,
  tcpPauses: 0, wsPauses: 0, overflows: 0,
};

function parseTarget(req) {
  let raw = '';
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    raw = u.searchParams.get('target') ?? '';
  } catch { /* ignore */ }
  if (!raw && DEFAULT_TARGET) raw = DEFAULT_TARGET;
  if (!raw) return { error: 'missing ?target=host:port' };

  // Allow plain `host:port` or full `tcp://host:port`.
  const m = /^(?:tcp:\/\/)?([^:/]+):(\d+)$/.exec(raw);
  if (!m) return { error: `bad target "${raw}", expected host:port` };
  const host = m[1];
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: `bad port ${port}` };
  }
  if (ALLOWLIST.length && !ALLOWLIST.includes(`${host}:${port}`)) {
    return { error: `target ${host}:${port} not in allowlist` };
  }
  return { host, port };
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, worker: cluster.worker?.id ?? 0, workersConfigured: BRIDGE_WORKERS, ...bridgeStats }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('this is a WebSocket bridge — connect via WS\n');
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: MAX_WS_PAYLOAD,
});

httpServer.on('upgrade', (req, socket, head) => {
  // Accept upgrades only on our path.
  let path = '/';
  try { path = new URL(req.url, 'http://x').pathname; } catch { /* ignore */ }
  if (path !== PATH) {
    bridgeStats.rejected++;
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  // The generic bridge has no private protocol of its own. Reject any offer
  // before opening upstream TCP; the NodeUO browser client immediately retries
  // without a subprotocol and can then talk to ServUO/POL unchanged.
  if (req.headers['sec-websocket-protocol']) {
    bridgeStats.rejected++;
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const parsed = parseTarget(req);
  if (parsed.error) {
    bridgeStats.rejected++;
    socket.write(`HTTP/1.1 400 Bad Request\r\n\r\n${parsed.error}\n`);
    socket.destroy();
    console.warn(`[bridge] reject upgrade: ${parsed.error}`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    bridge(ws, parsed.host, parsed.port, req.socket.remoteAddress || '?');
  });
});

/** @param {import('ws').WebSocket} ws */
function bridge(ws, host, port, fromAddr) {
  const id = nextId++;
  const tag = `[bridge#${id}]`;
  console.log(`${tag} ws ${fromAddr} -> tcp ${host}:${port}`);

  const tcp = net.connect({ host, port, writableHighWaterMark: 128 * 1024 });
  tcp.setNoDelay(true);
  tcp.setKeepAlive(true, 30_000);
  const connectTimer = setTimeout(() => fail(1013, 'tcp connect timeout'), TCP_CONNECT_TIMEOUT_MS);
  connectTimer.unref?.();
  let tcpReady = false;
  let tcpBlocked = false;
  let closed = false;
  /** @type {Buffer[]} */
  const wsPending = []; // bytes from ws received before tcp connected
  let wsPendingHead = 0;
  let wsPendingBytes = 0;
  bridgeStats.opened++;
  bridgeStats.active++;

  // Real UO servers (ServUO/RunUO/OSI) Huffman-compress server→client traffic
  // — but only AFTER the client sends 0x91 GameServerLogin. The earlier
  // LoginServer handshake (0xEF/0x80 → 0xA8 ServerList → 0xA0 → 0x8C Relay)
  // is plain. We do the decompression here in the bridge so the browser
  // client always sees plain bytes regardless of which side it talks to.
  let serverHuffman = false;
  let sawGameLogin = false;
  const huffmanDecoder = new UOHuffmanStreamDecoder();
  // ServUO/RunUO `Encryption.cs::DetermineClientType` reads the FIRST 4
  // bytes of the TCP stream as the client's "seed" (legacy: client IP
  // packed BE), then peeks the byte at offset 4 — must be 0x80 / 0x91 /
  // 0xEF for ServUO to accept the connection as NoEncryption. Without
  // the bare seed prefix ServUO logs "Encrypted Client Unsupported"
  // and disconnects (Marcin's symptom). Browser clients can't send
  // arbitrary leading bytes via the WS handshake, so the bridge
  // synthesizes the seed once before forwarding the first client
  // payload. Value: any non-zero u32; pick the WS peer's IP so logs
  // line up with Encryption.cs's expected "client IP" semantic.
  let seedSent = false;
  function makeBareSeed(ipString) {
    // Parse "127.0.0.1" → big-endian u32. Fallback to a stable non-zero
    // constant when the address can't be parsed (IPv6, ::ffff:1.2.3.4).
    const m = (ipString || '').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      return Buffer.from([+m[1] & 0xff, +m[2] & 0xff, +m[3] & 0xff, +m[4] & 0xff]);
    }
    return Buffer.from([0x7f, 0x00, 0x00, 0x01]); // 127.0.0.1
  }
  const bareSeed = makeBareSeed(fromAddr);

  function finish(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    bridgeStats.active = Math.max(0, bridgeStats.active - 1);
    bridgeStats.closed++;
    wsPending.length = 0;
    wsPendingBytes = 0;
    if (DEBUG) console.log(`${tag} closed (${reason})`);
  }

  function fail(code, reason) {
    finish(reason);
    try { ws.close(code, reason); } catch { /* ignore */ }
    try { tcp.destroy(); } catch { /* ignore */ }
  }

  function pauseWsInput() {
    if (ws._socket?.isPaused?.()) return;
    ws._socket?.pause?.();
    bridgeStats.wsPauses++;
  }

  function flushTcpQueue() {
    if (!tcpReady || tcpBlocked || closed) return;
    while (wsPendingHead < wsPending.length) {
      const payload = wsPending[wsPendingHead++];
      wsPendingBytes -= payload.length;
      bridgeStats.wsToTcpBytes += payload.length;
      if (!tcp.write(payload)) {
        tcpBlocked = true;
        pauseWsInput();
        break;
      }
    }
    if (wsPendingHead >= wsPending.length) {
      wsPending.length = 0;
      wsPendingHead = 0;
      wsPendingBytes = 0;
      if (!tcpBlocked) ws._socket?.resume?.();
    } else if (wsPendingHead > 256 && wsPendingHead * 2 >= wsPending.length) {
      wsPending.splice(0, wsPendingHead);
      wsPendingHead = 0;
    }
  }

  function queueTcp(payload) {
    if (closed) return;
    wsPending.push(payload);
    wsPendingBytes += payload.length;
    if (wsPendingBytes > MAX_PRECONNECT_BYTES) {
      bridgeStats.overflows++;
      fail(1009, 'tcp queue overflow');
      return;
    }
    flushTcpQueue();
  }

  function sendWs(payload) {
    if (closed || payload.length === 0 || ws.readyState !== ws.OPEN) return;
    const pending = Number(ws.bufferedAmount) || 0;
    if (pending + payload.length > WS_HARD_PENDING_BYTES) {
      bridgeStats.overflows++;
      fail(1013, 'websocket queue overflow');
      return;
    }
    if (pending + payload.length > WS_SOFT_PENDING_BYTES) {
      tcp.pause();
      bridgeStats.tcpPauses++;
    }
    bridgeStats.tcpToWsBytes += payload.length;
    ws.send(payload, { binary: true }, (error) => {
      if (error) {
        fail(1011, 'websocket send failed');
        return;
      }
      if (!closed && (Number(ws.bufferedAmount) || 0) <= WS_SOFT_PENDING_BYTES) tcp.resume();
    });
  }

  tcp.on('connect', () => {
    clearTimeout(connectTimer);
    tcpReady = true;
    flushTcpQueue();
  });
  tcp.on('drain', () => {
    tcpBlocked = false;
    flushTcpQueue();
    if (!tcpBlocked && wsPendingBytes === 0) ws._socket?.resume?.();
  });
  tcp.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN || closed) return;
    if (!serverHuffman) {
      sendWs(chunk);
      return;
    }
    // TCP may split a Huffman symbol or packet at any byte. The stateful
    // decoder keeps the partial tree node between reads; the browser still
    // receives the original uncompressed UO byte stream in the same order.
    let plain;
    try { plain = huffmanDecoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); }
    catch (e) {
      console.warn(`${tag} huffman decompress failed: ${e.message}`);
      fail(1011, 'huffman error');
      return;
    }
    bridgeStats.decodedBytes += plain.length;
    if (DEBUG) {
      const n = Math.min(plain.length, DEBUG_BYTES);
      const hex = Array.from(plain.subarray(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      // Find positions of 0x1B in the chunk to spot LoginConfirm and measure
      // the gap to the next plausible opcode boundary.
      const occurrences = [];
      for (let i = 0; i < plain.length; i++) if (plain[i] === 0x1b) occurrences.push(i);
      const occStr = occurrences.length ? ` 0x1b@[${occurrences.join(',')}]` : '';
      console.log(`${tag} dec ${plain.length}B${occStr} | ${hex}${plain.length > n ? '…' : ''}`);
    }
    sendWs(Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength));
  });
  tcp.on('error', (err) => {
    console.warn(`${tag} tcp error: ${err.message}`);
    fail(1011, 'tcp error');
  });
  tcp.on('close', () => {
    console.log(`${tag} tcp closed`);
    finish('tcp closed');
    try { ws.close(1000, 'tcp closed'); } catch { /* ignore */ }
  });

  ws.on('message', (data, isBinary) => {
    // ws.send may pass us a Buffer for binary or a string for text. UO is
    // binary-only, so anything text-y is a bug — drop it rather than forward
    // garbage that desyncs the framer.
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d))))
        : Buffer.from(data);
    // Sniff for the first 0x91 (GameServerLogin). After the *next* TCP read,
    // server starts compressing. We flip the flag the moment we forward 0x91
    // upstream; ServUO won't send compressed bytes before it has processed
    // 0x91, so any plain bytes still in flight are already past us.
    if (!sawGameLogin && buf.length >= 1 && buf[0] === 0x91) {
      sawGameLogin = true;
      serverHuffman = true;
      console.log(`${tag} client sent 0x91 — enabling huffman decompression`);
    }
    if (DEBUG) {
      const n = Math.min(buf.length, 32);
      const hex = Array.from(buf.subarray(0, n)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`${tag} ws→tcp ${buf.length}B op=0x${buf[0].toString(16).padStart(2, '0')} | ${hex}`);
    }
    // Prepend the bare 4-byte seed before the very first byte we forward
    // to ServUO. Required by `Server/Network/Encryption.cs::DetermineClientType` —
    // see the comment near `bareSeed` above. Skip when the client is
    // already sending bytes that LOOK like a 4-byte seed (e.g. it ran
    // an older flow that prepends them itself); detect by checking
    // whether the byte AT offset 4 of the first chunk is a valid
    // login opcode (0xEF / 0x80 / 0x91). This stays out of the way
    // for clients that don't need the prefix.
    let toSend = buf;
    if (!seedSent) {
      seedSent = true;
      const looksLikeAlreadyPrefixed =
        buf.length >= 5 &&
        (buf[4] === 0xEF || buf[4] === 0x80 || buf[4] === 0x91);
      if (!looksLikeAlreadyPrefixed) {
        toSend = Buffer.concat([bareSeed, buf]);
        if (DEBUG) {
          console.log(`${tag} prepended bare seed ${Array.from(bareSeed).map((b) => b.toString(16).padStart(2, '0')).join(' ')} for ServUO Encryption.DetermineClientType`);
        }
      }
    }
    queueTcp(toSend);
  });
  ws.on('close', () => {
    console.log(`${tag} ws closed`);
    finish('ws closed');
    try { tcp.end(); } catch { /* ignore */ }
  });
  ws.on('error', (err) => {
    console.warn(`${tag} ws error: ${err.message}`);
    finish('ws error');
    try { tcp.destroy(); } catch { /* ignore */ }
  });
}

httpServer.listen(PORT, HOST, () => {
  const allow = ALLOWLIST.length ? `allowlist=${ALLOWLIST.join(',')}` : 'allowlist=*';
  const def = DEFAULT_TARGET ? ` default=${DEFAULT_TARGET}` : '';
  const dbg = DEBUG ? ` debug=on(${DEBUG_BYTES}B)` : '';
  console.log(`[bridge] ws://${HOST}:${PORT}${PATH}?target=HOST:PORT  (${allow}${def}${dbg})`);
});

const shutdown = () => {
  console.log('[bridge] shutting down');
  httpServer.close();
  wss.close();
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
