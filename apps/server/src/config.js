// Server configuration. Everything overridable via env vars for simple
// deployments; see README for full list.

export const config = Object.freeze({
  host: process.env.UO_HOST ?? '0.0.0.0',
  port: Number(process.env.UO_PORT ?? 2593),
  protocolMode: 'uo',
  // Optional raw-TCP listener for legacy UO clients (Razor / Steam / OSI /
  // ClassicUO desktop). When set, the server starts a second listener on
  // this port that speaks the byte-identical ServUO wire format over plain
  // TCP. Browser clients keep using the WebSocket port. Unset = WS only.
  // Conventional value: 2594 (one above the WS port). DO NOT set equal to
  // `port` — same-port WS+TCP would collide.
  tcpPort: process.env.UO_TCP_PORT ? Number(process.env.UO_TCP_PORT) : null,
  // Optional: override the bind host for the TCP listener specifically.
  // Useful when WS is bound 0.0.0.0 (LAN play) but you want CUO to only
  // be reachable from localhost (loopback-only) for safety. Defaults to
  // UO_HOST so existing setups keep working.
  tcpHost: process.env.UO_TCP_HOST ?? process.env.UO_HOST ?? '0.0.0.0',
  shardName: process.env.UO_SHARD_NAME ?? 'UO-Node',
  advertisedAddress: process.env.UO_ADVERTISED_ADDRESS ?? '127.0.0.1',
  // When true, outgoing packets are Huffman-compressed bit-identically to the
  // ServUO encoder. Required for real UO clients; our browser client reads
  // both compressed and uncompressed. Keep on by default for fidelity.
  huffmanOutgoing: (process.env.UO_HUFFMAN ?? '1') !== '0',
  // Accept any password. For real accounts use an auth backend.
  devAutoAccept: (process.env.UO_DEV_AUTO_ACCEPT ?? '1') === '1',
  logPackets: (process.env.UO_LOG_PACKETS ?? '0') === '1',
});
