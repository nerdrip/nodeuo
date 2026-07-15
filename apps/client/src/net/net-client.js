// NetClient — owns the WebSocket to our shard. Mirrors ClassicUO's
// Network/NetClient.cs (but radically simpler: no encryption layer for
// browser clients — the server is configured to accept plain bytes, with
// optional outbound Huffman compression).
//
// Wire format:
//   client → server : raw UO bytes, no framing wrapper
//   server → client : raw UO bytes, optionally Huffman-compressed
//
// We frame inbound bytes via `frameServerStream` (server-direction opcode
// table) and dispatch each packet to a registered handler keyed by opcode.
// Unhandled opcodes are surfaced as 'net:unhandled' bus events for debug.

import { huffmanDecompress } from '@uo/protocol';
import { frameServerStream, SERVER_OPCODES } from './incoming-table.js';
import { bus } from '../core/event-bus.js';
import { buildUnicodeSpeech } from './outgoing.js';
import { SessionEpoch } from '../shared/runtime-governor.js';

/** Quick "is this byte a known server opcode?" check for the Huffman
 *  auto-probe. Both the SERVER_OPCODES table (numeric keys) and a few
 *  always-allowed opcodes (0x73 ping, 0xA8 server list, 0x8C relay,
 *  0xB9 features, 0x1B login confirm, 0xBF extended) cover every byte
 *  the server can legitimately put on the wire as the FIRST byte of
 *  a frame. Anything else is garbage from a wrong-mode decompression. */
function _isKnownServerOpcode(byte) {
  return !!SERVER_OPCODES[byte];
}

export class NetClient {
  constructor() {
    /** @type {WebSocket | null} */
    this.ws = null;
    // Ring buffer for inbound bytes. Pre-allocated so the hot path
    // `_onMessage` doesn't churn the GC with per-frame `new Uint8Array(N)`
    // allocations + spread-merges. Capacity grows on demand if a single
    // huffman-decompressed payload exceeds it (rare — UO packets cap
    // around 32 KB). Compaction shifts unconsumed bytes to the start
    // when free space at the tail runs out.
    this._rxBuf = new Uint8Array(64 * 1024);
    this._rxLen = 0;            // valid bytes in [0, _rxLen)
    /** @type {Map<number, (pkt: Uint8Array) => void>} */
    this._handlers = new Map();
    /** server→client packets are huffman-compressed by default (matches
     *  our uo-node shard's UO_HUFFMAN=1 default and ServUO's post-relay
     *  game-server stream). For ServUO LOGIN servers (port 2593) the
     *  first frames are RAW until the relay handoff — `_huffmanProbed`
     *  flips this off automatically when the first frame's raw bytes
     *  parse as a valid UO opcode (0xA8 ServerList etc.). */
    this.serverHuffman = true;
    this._huffmanProbed = false;
    /** @type {string} '' = idle / 'connecting' / 'open' / 'closed' / 'error' */
    this.state = '';
    /** @type {string | null} last error message */
    this.error = null;
    /** Cumulative network counters surfaced by NetworkStatsGump (CUO parity).
     *  Kept here rather than in a manager so we can update them inline on the
     *  socket hot paths without an extra event emit per packet. */
    this.stats = {
      bytesSent: 0,        // raw bytes pushed to ws.send (post-huffman if any)
      bytesReceived: 0,    // raw bytes from onmessage (pre-huffman)
      bytesDecoded: 0,     // post-huffman framed bytes — lets us see compression ratio
      packetsSent: 0,
      packetsReceived: 0,
      lastSendAt: 0,
      lastRecvAt: 0,
      // Per-opcode bucket — populated only when `trackOpcodes` is true
      // (off by default to keep the hot path branch-light). Set via
      // `net.trackOpcodes = true` from a debug command.
      perOpcodeRx: Object.create(null),
      perOpcodeTx: Object.create(null),
    };
    this.trackOpcodes = false;
    /** NodeUO private features are off until both the WebSocket subprotocol
     * and the in-band capability offer have completed. */
    this.nodeUOTransport = false;
    this.nodeUONegotiated = false;
    this.nodeUOCapabilities = 0;
    this.sessionEpoch = new SessionEpoch();
    this.frameDiagnostics = {
      warnings: 0, consecutive: 0, resyncRequests: 0, recent: [], unknownFrames: [], resyncReports: [],
    };
    try { this.tracePackets = globalThis.localStorage?.uoTrace === '1'; }
    catch { this.tracePackets = false; }
    try { this.debugHues = globalThis.localStorage?.uoHueDebug === '1'; }
    catch { this.debugHues = false; }
  }

  /** Bump per-opcode RX counter when tracking is enabled. Safe to call
   *  in hot paths — no-op when disabled. */
  _bumpRx(opcode) {
    if (!this.trackOpcodes) return;
    const k = opcode & 0xFF;
    this.stats.perOpcodeRx[k] = (this.stats.perOpcodeRx[k] | 0) + 1;
  }
  _bumpTx(opcode) {
    if (!this.trackOpcodes) return;
    const k = opcode & 0xFF;
    this.stats.perOpcodeTx[k] = (this.stats.perOpcodeTx[k] | 0) + 1;
  }

  // Compatibility shim — older code reads `net._rx` for diagnostics. Return
  // a view over the live buffer (no copy).
  get _rx() { return this._rxBuf.subarray(0, this._rxLen); }

  /** Register a handler for a server opcode. Replaces existing handler. */
  on(opcode, fn) { this._handlers.set(opcode, fn); }

  /** Send a normal shard command through standard UO Unicode speech. */
  sendCommand(command) {
    const text = String(command ?? '').trim();
    if (!text) return false;
    this.send(buildUnicodeSpeech(text.startsWith('[') ? text : `[${text}`));
    return true;
  }

  /** Connect to a `ws://host:port/path` URL. Resolves on open, rejects on error/close-before-open. */
  connect(url) {
    return new Promise((resolve, reject) => {
      const epoch = this.sessionEpoch.advance();
      bus.emit('net:session-reset', { epoch });
      // Client audit #4 C1/C2 — close + clear any prior socket so a
      // reconnect doesn't leak the previous handlers (which would later
      // emit `net:close` mid-second-session and bounce the user back to
      // LoginScene). Also reset the rx framer + Huffman probe so stale
      // bytes from the previous session can't desync the new framer.
      if (this.ws) {
        try {
          this.ws.onopen = this.ws.onclose = null;
          this.ws.onerror = this.ws.onmessage = null;
          this.ws.close();
        } catch { /* ignore */ }
      }
      this._rxLen = 0;
      clearTimeout(this._decoderWatchdogTimer);
      this._decoderWatchdogTimer = null;
      this._huffmanProbed = false;
      this.serverHuffman = true;
      this.nodeUOTransport = false;
      this.nodeUONegotiated = false;
      this.nodeUOCapabilities = 0;
      this.state = 'connecting';

      // Ask for our optional transport first. If a generic UO WebSocket
      // bridge rejects unknown subprotocols, retry the exact same URL with
      // no subprotocol. No private UO packet is ever sent during probing,
      // so arbitrary ServUO/emulator bridges retain full compatibility.
      const open = (offerNodeUO) => {
        let ws;
        try {
          ws = offerNodeUO ? new WebSocket(url, ['nodeuo.v1']) : new WebSocket(url);
          this.ws = ws;
        } catch (e) {
          if (offerNodeUO) { open(false); return; }
          this.state = 'error';
          this.error = e.message;
          reject(e);
          return;
        }
        ws.binaryType = 'arraybuffer';
        let opened = false;
        let retired = false;
        const fallback = () => {
          if (!offerNodeUO || retired || opened) return false;
          retired = true;
          ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
          try { ws.close(); } catch { /* ignore */ }
          open(false);
          return true;
        };

        ws.onopen = () => {
          if (retired || !this.sessionEpoch.valid(epoch) || this.ws !== ws) return;
          opened = true;
          this.nodeUOTransport = ws.protocol === 'nodeuo.v1';
          this.state = 'open';
          bus.emit('net:open');
          resolve();
        };
        ws.onerror = (ev) => {
          if (!this.sessionEpoch.valid(epoch) || this.ws !== ws) return;
          if (fallback()) return;
          this.error = 'websocket error';
          bus.emit('net:error', ev);
          if (!opened) reject(new Error(this.error));
        };
        ws.onclose = (ev) => {
          if (retired || !this.sessionEpoch.valid(epoch) || this.ws !== ws || fallback()) return;
          this.state = 'closed';
          this.nodeUONegotiated = false;
          this.nodeUOCapabilities = 0;
          bus.emit('net:close', { code: ev.code, reason: ev.reason });
          if (!opened) reject(new Error(`websocket closed before open (code ${ev.code})`));
        };
        ws.onmessage = (ev) => {
          if (this.sessionEpoch.valid(epoch) && this.ws === ws) this._onMessage(ev.data, epoch);
        };
      };
      open(true);
    });
  }

  close() {
    const epoch = this.sessionEpoch.advance();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
    this._rxLen = 0;
    clearTimeout(this._decoderWatchdogTimer);
    this._decoderWatchdogTimer = null;
    // Reset the Huffman probe so a fresh connection (e.g. switching
    // from our shard to a ServUO bridge) re-detects the mode.
    this._huffmanProbed = false;
    this.nodeUOTransport = false;
    this.nodeUONegotiated = false;
    this.nodeUOCapabilities = 0;
    bus.emit('net:session-reset', { epoch });
  }

  supportsNodeUO(capability) {
    return this.nodeUONegotiated
      && (((this.nodeUOCapabilities >>> 0) & (capability >>> 0)) === (capability >>> 0));
  }

  /** Ensure the rx buffer has at least `extra` bytes of free tail space. */
  _ensureRxCapacity(extra) {
    const needed = this._rxLen + extra;
    if (needed <= this._rxBuf.length) return;
    // Try compaction first — shift in place is free if we hadn't already.
    // (We don't track a head pointer; once frameServerStream consumes
    // bytes we copyWithin to slot 0 immediately. So if we're here, the
    // buffer is genuinely too small.)
    let cap = this._rxBuf.length;
    while (cap < needed) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this._rxBuf.subarray(0, this._rxLen));
    this._rxBuf = grown;
  }

  /** True when the socket is fully connected and accepting frames. */
  get isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** @param {Uint8Array} bytes */
  send(bytes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[net] send before open, dropped opcode 0x' + bytes[0].toString(16));
      return;
    }
    // Backpressure guard. Client perf round 2 #12: above the soft threshold
    // (512 KB), DROP low-priority chatter (LookReq / status / property /
    // ping) but keep high-priority traffic (movement, lift/drop, speech,
    // command). Above hard (1 MiB) log a warn. Without throttling, dense
    // auto-LookReq + tooltip bursts could overrun the kernel TX buffer
    // on slow uplinks and force the browser to drop the WebSocket.
    const SOFT_WATER = 1 << 19;
    const HIGH_WATER = 1 << 20;
    const opcode = bytes[0];
    if (this.ws.bufferedAmount > SOFT_WATER) {
      // 0x09 LookReq, 0xBF (sub 0x10) QueryProperties, 0x34 StatusReq,
      // 0x73 Ping — all OK to drop when the link is congested.
      if (opcode === 0x09 || opcode === 0xBF || opcode === 0x34 || opcode === 0x73) {
        return;
      }
    }
    if (this.ws.bufferedAmount > HIGH_WATER) {
      const now = performance.now();
      if (!this._lastBackpressureAt || now - this._lastBackpressureAt > 5000) {
        this._lastBackpressureAt = now;
        console.warn(
          `[net] WS bufferedAmount=${(this.ws.bufferedAmount / 1024) | 0}KB ` +
          `(opcode 0x${opcode.toString(16)}) — server may be stalled.`,
        );
      }
    }
    // Send a fresh ArrayBuffer slice (browser WS rejects shared/large views).
    const frame = bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
    this.ws.send(frame);
    bus.emit('net:packet-meta', { direction: 'tx', bytes: frame });
    this.stats.bytesSent += frame.byteLength;
    this.stats.packetsSent += 1;
    this.stats.lastSendAt = performance.now();
    this._bumpTx(frame[0]);
    // Diagnostic: trace every outgoing opcode + size + first 8 bytes hex.
    // Set `net.tracePackets = true` or reload with localStorage.uoTrace = '1'.
    if (this.tracePackets) {
      let head = '';
      const headLen = Math.min(8, frame.length);
      for (let i = 0; i < headLen; i++) {
        if (i) head += ' ';
        head += frame[i].toString(16).padStart(2, '0');
      }
      console.log(`[trace tx] op=0x${opcode.toString(16)} size=${frame.length} bytes head=${head} ` +
        `wsBuf=${this.ws.bufferedAmount}`);
    }
  }

  _onMessage(data, epoch = this.sessionEpoch.capture()) {
    if (!this.sessionEpoch.valid(epoch)) return;
    /** @type {Uint8Array} */
    let raw;
    if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof data === 'string') {
      console.warn('[net] dropped text frame:', data);
      return;
    } else {
      console.warn('[net] dropped unknown frame type:', typeof data);
      return;
    }
    this.stats.bytesReceived += raw.byteLength;
    this.stats.lastRecvAt = performance.now();

    // Decompress if huffman is enabled. ServUO sends one logical packet
    // per WS frame, but the bridge may forward multiple — our framer
    // handles both by buffering.
    //
    // Per-frame auto-probe. ServUO/CUO convention: the LOGIN phase
    // (0xA8 ServerList, 0x8C Relay) is uncompressed; AFTER the client
    // sends 0x91 GameLogin the server's game phase output is Huffman'd.
    // For our shard the stage transition mid-session means the SAME
    // socket flips mode. Try the current mode first, and if the
    // decoded byte 0 isn't a recognised UO server opcode, try the
    // opposite mode and lock to whichever wins. The probe cost on
    // a known-mode stream is one extra Map lookup per frame.
    let plain = this._tryDecode(raw, this.serverHuffman);
    const ok = plain && plain.length > 0 && _isKnownServerOpcode(plain[0]);
    if (!ok) {
      const flipped = this._tryDecode(raw, !this.serverHuffman);
      if (flipped && flipped.length > 0 && _isKnownServerOpcode(flipped[0])) {
        this.serverHuffman = !this.serverHuffman;
        plain = flipped;
        console.log(`[net] huffman auto-flipped: ${this.serverHuffman ? 'ON' : 'OFF'} (first opcode 0x${plain[0].toString(16)})`);
      }
    }
    this._huffmanProbed = true;
    if (!plain) return;

    this.stats.bytesDecoded += plain.length;
    // Append to rx ring buffer (no per-frame alloc).
    this._ensureRxCapacity(plain.length);
    this._rxBuf.set(plain, this._rxLen);
    this._rxLen += plain.length;

    const view = this._rxBuf.subarray(0, this._rxLen);
    const { packets, consumed, warnings } = frameServerStream(view);
    if (warnings && warnings.length > 0) {
      this.frameDiagnostics.warnings += warnings.length;
      this.frameDiagnostics.consecutive++;
      for (const w of warnings) {
        console.warn('[net]', w);
        this.frameDiagnostics.recent.push(String(w).slice(0, 240));
        const diagnosticBytes = plain.subarray(0, Math.min(64, plain.length));
        this.frameDiagnostics.unknownFrames.push({
          at: Date.now(), signature: String(w).slice(0, 160),
          hex: [...diagnosticBytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
        });
      }
      if (this.frameDiagnostics.recent.length > 16) {
        this.frameDiagnostics.recent.splice(0, this.frameDiagnostics.recent.length - 16);
      }
      if (this.frameDiagnostics.unknownFrames.length > 8) {
        this.frameDiagnostics.unknownFrames.splice(0, this.frameDiagnostics.unknownFrames.length - 8);
      }
      if (this.frameDiagnostics.consecutive >= 3) {
        this.frameDiagnostics.consecutive = 0;
        this.frameDiagnostics.resyncRequests++;
        this._recordResyncReport('frame-warning', warnings[0], consumed);
        bus.emit('net:resync-request', { reason: 'frame-watchdog' });
      }
    } else {
      this.frameDiagnostics.consecutive = 0;
    }
    if (consumed > 0) {
      clearTimeout(this._decoderWatchdogTimer);
      this._decoderWatchdogTimer = null;
      // Compact unconsumed bytes back to slot 0. copyWithin handles
      // overlapping ranges correctly and is a couple of memcpy()s
      // worth of cost — much cheaper than the old subarray + set
      // path that allocated a new view AND kept the original buffer
      // alive until the next frame.
      const remaining = this._rxLen - consumed;
      if (remaining > 0) this._rxBuf.copyWithin(0, consumed, this._rxLen);
      this._rxLen = remaining;
    } else if (this._rxLen > 0 && !this._decoderWatchdogTimer) {
      const expectedEpoch = epoch;
      const expectedLength = this._rxLen;
      this._decoderWatchdogTimer = setTimeout(() => {
        this._decoderWatchdogTimer = null;
        if (!this.sessionEpoch.valid(expectedEpoch) || this._rxLen !== expectedLength || this._rxLen === 0) return;
        this.frameDiagnostics.resyncRequests++;
        this._recordResyncReport('decoder-stall', 'no decoder progress for 2000ms', 0);
        bus.emit('net:resync-request', { reason: 'decoder-stall' });
      }, 2000);
    }

    this.stats.packetsReceived += packets.length;
    for (const pkt of packets) {
      if (!this.sessionEpoch.valid(epoch)) break;
      this._dispatch(pkt);
    }
  }

  _recordResyncReport(reason, signature, offset = 0) {
    const row = { at: Date.now(), reason: String(reason), offset: offset | 0, signature: String(signature).slice(0, 200) };
    this.frameDiagnostics.resyncReports.push(row);
    if (this.frameDiagnostics.resyncReports.length > 16) this.frameDiagnostics.resyncReports.shift();
    bus.emit('net:resync-report', row);
    return row;
  }

  _dispatch(pkt) {
    bus.emit('net:packet-meta', { direction: 'rx', bytes: pkt });
    const opcode = pkt[0];
    this._bumpRx(opcode);
    const handler = this._handlers.get(opcode);
    if (handler) {
      try { handler(pkt); }
      catch (e) { console.error(`[net] handler 0x${opcode.toString(16)} threw`, e); }
    } else {
      bus.emit('net:unhandled', { opcode, pkt });
    }
  }

  /** Decode `raw` either via Huffman or pass-through. Returns null on
   *  Huffman failure (so caller can fall back / drop the frame). */
  _tryDecode(raw, useHuffman) {
    if (!useHuffman) return raw;
    try { return huffmanDecompress(raw); }
    catch { return null; }
  }

  /** Force the Huffman-incoming setting and reset the auto-probe. Call
   *  this from the connect path when you KNOW which mode applies (e.g.
   *  bridge UI explicitly toggles ServUO compatibility). */
  setServerHuffman(on) {
    this.serverHuffman = !!on;
    this._huffmanProbed = false;
  }
}

export const net = new NetClient();
