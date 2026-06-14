// Raw-TCP listener for legacy UO clients (UO Steam, Razor, stock OSI,
// ClassicUO desktop). Browser clients use the WebSocket path; this is
// a parallel listener on a separate port that gives those classic
// clients a way in WITHOUT running a separate TCP↔WS bridge process.
//
// The wire format is identical (the same ServUO-compatible byte stream
// produced by `@uo/protocol`). The only transport difference is the
// initial 4-byte bare seed prefix that real UO clients send before
// their first opcode — handled by TcpAdapter. Everything else (login
// flow, gameplay opcodes, Huffman compression of server→client) flows
// through unchanged.

import net from 'node:net';
import { TcpAdapter } from './tcp-adapter.js';
import { NetState } from './net-state.js';

/**
 * Start a TCP listener that accepts native UO clients. Each accepted
 * socket gets wrapped in a TcpAdapter and handed to a fresh NetState,
 * exactly the same way as the WebSocket path. Returns the server so
 * the caller can close it on shutdown.
 *
 * @param {object}   opts
 * @param {string}   opts.host
 * @param {number}   opts.port
 * @param {object}   opts.sharedCtx     same context the WS path passes
 * @param {(s:string)=>void} [opts.log]
 * @returns {import('node:net').Server}
 */
export function startTcpListener({ host, port, sharedCtx, log = console.log }) {
  let connId = 0;
  const server = net.createServer((socket) => {
    const id = ++connId;
    const remoteAddress = socket.remoteAddress;
    log(`[tcp#${id}] connected from ${remoteAddress}:${socket.remotePort}`);

    // First-byte diagnostics — log what the client SENDS as soon as the
    // initial chunk arrives. Without this the server log is silent
    // between "connected" and the first parsed packet, which makes
    // "ClassicUO doesn't connect" hard to triage. Marcin: "nie mam
    // żadnych logów w naszym terminalu". One-shot listener: removed
    // after the first chunk so we don't log every byte forever.
    const onFirstChunk = (chunk) => {
      socket.removeListener('data', onFirstChunk);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const head = bytes.subarray(0, Math.min(16, bytes.length));
      const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      log(`[tcp#${id}] first chunk ${bytes.length}B: ${hex}${bytes.length > 16 ? ' …' : ''}`);
    };
    // 'data' listeners are fired in registration order; this one runs
    // BEFORE TcpAdapter's, peeks at the bytes, then bows out.
    socket.on('data', onFirstChunk);

    // 5-second silent-client watchdog. Some firewalls / proxies open the
    // TCP connection but never forward client bytes (commonly the case
    // when CUO's "encryption" toggle is left on and our server speaks
    // plaintext). Print a hint so the operator knows where to look.
    const silentTimer = setTimeout(() => {
      log(`[tcp#${id}] no data after 5s — check that ClassicUO has encryption DISABLED + correct host:port (currently ${host}:${port}).`);
    }, 5_000);
    socket.on('data', () => clearTimeout(silentTimer));
    socket.on('close', () => clearTimeout(silentTimer));

    socket.on('close', (hadError) => {
      log(`[tcp#${id}] closed${hadError ? ' (with error)' : ''}`);
    });
    socket.on('error', (err) => {
      log(`[tcp#${id}] socket error: ${err.code || err.message}`);
    });

    const adapter = new TcpAdapter(socket);
    // NetState only knows it has something WebSocket-shaped — the
    // `ctx.id` tag prefixes every log line so TCP/WS connections are
    // distinguishable in the server log.

    new NetState(adapter, { ...sharedCtx, id: `tcp${id}`, remoteAddress });
  });

  server.on('error', (err) => {
    log(`[uo-node] TCP listener error: ${err.code || err.message}`);
    if (err.code === 'EADDRINUSE') {
      log(`[uo-node] port ${port} is busy — another process holds it. Either stop that process or change UO_TCP_PORT.`);
    } else if (err.code === 'EACCES') {
      log(`[uo-node] permission denied binding ${host}:${port}. Pick a port > 1024 or run with elevated permissions.`);
    }
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const actualHost = (addr && typeof addr === 'object') ? addr.address : host;
    const actualPort = (addr && typeof addr === 'object') ? addr.port : port;
    log(`[uo-node] TCP listening on ${actualHost}:${actualPort} (legacy UO clients — Razor / Steam / OSI / CUO desktop)`);
    if (actualHost === '0.0.0.0' || actualHost === '::') {
      log(`[uo-node]   → connect ClassicUO to 127.0.0.1:${actualPort} (or your LAN IP) with encryption DISABLED.`);
    }
    // Periodic "still idle" heartbeat so the operator knows the listener
    // is alive but no client has dialed in. Pings every 30s for the
    // first 5 minutes only, then goes quiet — long enough to surface
    // "I configured CUO and nothing happened" but not so spammy that
    // it pollutes the log for a healthy long-running shard.
    let pingsLeft = 10;
    const ping = setInterval(() => {
      if (connId > 0 || pingsLeft-- <= 0) { clearInterval(ping); return; }
      log(`[uo-node] TCP listener idle on ${actualHost}:${actualPort} — no client connections yet. Check that CUO's host=${actualHost === '0.0.0.0' ? '127.0.0.1' : actualHost}, port=${actualPort}, encryption=NONE.`);
    }, 30_000);
    if (typeof ping.unref === 'function') ping.unref();
  });

  return server;
}
