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
import {
  advertisedFeatureList,
  buildNodeUOManifest,
  createNodeUORpcCancel,
  createNodeUORpcRequest,
  createNodeUOMessage,
  featureIdForNamespace,
  isNodeUOMessageExpired,
  negotiateFeatures,
  NODEUO_JSON_SUBPROTOCOL,
  NodeUOChannelMessage,
  NodeUODelivery,
  NodeUOJsonKind,
  parseNodeUOFrame,
  profileFeatureIds,
  schemaFingerprintForFeature,
  serializeNodeUOMessage,
  serializeNodeUOFrame,
  parseNodeUOMessage,
} from '@uo/nodeuo-protocol';
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

export class NodeUORequestError extends Error {
  constructor(message, { code = 'internal', details, retryAfterMs, recovery,
    traceId, correlationId, transactionId } = {}) {
    super(message);
    this.name = 'NodeUORequestError';
    this.code = code;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
    this.recovery = recovery;
    this.traceId = traceId;
    this.correlationId = correlationId;
    this.transactionId = transactionId;
  }
}

function nodeUOClientId(prefix = 'trace') {
  return `${prefix}.${globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`}`;
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
    this.nodeUOJsonTransport = false;
    this.nodeUOTransportVersion = '';
    this.nodeUONegotiated = false;
    this.nodeUOFeatures = new Map();
    try {
      const storedProfile = globalThis.localStorage?.getItem?.('uo.nodeuo.profile');
      this._nodeUOProfileExplicit = !!storedProfile;
      this.nodeUOProfile = storedProfile || 'full';
    }
    catch { this._nodeUOProfileExplicit = false; this.nodeUOProfile = 'full'; }
    this.nodeUOManifest = null;
    this._nodeUOJsonHandler = null;
    this._nodeUODisabledFeatures = new Set();
    this._nodeUORequests = new Map();
    this._nodeUORequestId = 0;
    this._nodeUOJsonDeferred = new Map();
    this._nodeUOJsonFlushTimer = null;
    this.nodeUOJsonStats = { sent: 0, received: 0, deferred: 0, coalesced: 0, dropped: 0, expired: 0,
      framesSent: 0, framesReceived: 0, batchedMessages: 0 };
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
    return this.send(buildUnicodeSpeech(text.startsWith('[') ? text : `[${text}`)) !== false;
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
      this.nodeUOJsonTransport = false;
      this.nodeUOTransportVersion = '';
      this.nodeUONegotiated = false;
      this.nodeUOFeatures.clear();
      this.nodeUOManifest = null;
      clearTimeout(this._nodeUOJsonFlushTimer);
      this._nodeUOJsonFlushTimer = null;
      this._nodeUOJsonDeferred.clear();
      this._rejectNodeUORequests('session reset');
      this.state = 'connecting';

      // Ask for our optional transport first. If a generic UO WebSocket
      // bridge rejects unknown subprotocols, retry the exact same URL with
      // no subprotocol. No private UO packet is ever sent during probing,
      // so arbitrary ServUO/emulator bridges retain full compatibility.
      const open = (offerNodeUO) => {
        let ws;
        try {
          ws = offerNodeUO
            ? new WebSocket(url, NODEUO_JSON_SUBPROTOCOL)
            : new WebSocket(url);
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
          this.nodeUOTransportVersion = ws.protocol;
          this.nodeUOJsonTransport = ws.protocol === NODEUO_JSON_SUBPROTOCOL;
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
          this.nodeUOFeatures.clear();
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
    this.nodeUOJsonTransport = false;
    this.nodeUOTransportVersion = '';
    this.nodeUONegotiated = false;
    this.nodeUOFeatures.clear();
    this.nodeUOManifest = null;
    clearTimeout(this._nodeUOJsonFlushTimer);
    this._nodeUOJsonFlushTimer = null;
    this._nodeUOJsonDeferred.clear();
    this._rejectNodeUORequests('connection closed');
    bus.emit('net:session-reset', { epoch });
  }

  supportsNodeUO(capability) {
    if (!this.nodeUOJsonTransport || !this.nodeUONegotiated
        || typeof capability !== 'string') return false;
    const feature = capability.trim().toLowerCase();
    return !!feature && !this._nodeUODisabledFeatures.has(feature)
      && this.nodeUOFeatures.has(feature);
  }

  receiveNodeUODatagram(bytes) {
    if (!this.nodeUOJsonTransport) return false;
    try {
      const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const message = parseNodeUOMessage(text);
      if (message.delivery !== NodeUODelivery.LossTolerant
          && message.delivery !== NodeUODelivery.Latest) return false;
      return this._onNodeUOJsonMessage(message);
    } catch { return false; }
  }

  sendNodeUORequest({ channel: _channel, namespace, payload = {}, capability = null, timeoutMs = 5000,
    expectedRevision, idempotencyKey, priority, delivery, ttlMs, traceId, correlationId,
    causationId, transactionId, deadlineAt, preconditions, signal } = {}) {
    if (!this.nodeUONegotiated || (capability && !this.supportsNodeUO(capability))) {
      return Promise.reject(new Error('NodeUO capability is unavailable'));
    }
    if (signal?.aborted) return Promise.reject(new globalThis.DOMException('The request was aborted', 'AbortError'));
    const requestId = (++this._nodeUORequestId) >>> 0 || ++this._nodeUORequestId;
    const feature = typeof capability === 'string' ? capability : featureIdForNamespace(namespace);
    const id = `c.${requestId}`;
    const wirePayload = feature === 'mods.channels' ? { namespace, data: payload } : payload;
    return new Promise((resolve, reject) => {
        const boundedTimeout = Math.max(250, Math.min(30_000, timeoutMs | 0));
        const requestTraceId = traceId || nodeUOClientId();
        const requestCorrelationId = correlationId || requestTraceId;
        const abort = () => {
          const pending = this._nodeUORequests.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this._nodeUORequests.delete(id);
          reject(new globalThis.DOMException('The request was aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          this._nodeUORequests.delete(id);
          signal?.removeEventListener?.('abort', abort);
          reject(new NodeUORequestError(`NodeUO request timed out: ${feature}`, {
            code: 'timeout', traceId: requestTraceId, correlationId: requestCorrelationId,
            transactionId,
          }));
        }, boundedTimeout);
        this._nodeUORequests.set(id, { resolve, reject, timer, namespace: feature,
          signal, abort, traceId: requestTraceId, correlationId: requestCorrelationId,
          transactionId });
        signal?.addEventListener?.('abort', abort, { once: true });
        if (!this.sendNodeUOMessage({ kind: NodeUOJsonKind.Request, feature, id, payload: wirePayload,
          expectedRevision, idempotencyKey, priority, delivery, ttlMs,
          traceId: requestTraceId, correlationId: requestCorrelationId, causationId,
          transactionId, deadlineAt: deadlineAt ?? Date.now() + boundedTimeout,
          preconditions })) {
          clearTimeout(timer); signal?.removeEventListener?.('abort', abort); this._nodeUORequests.delete(id);
          reject(new Error('connection is not writable'));
        }
    });
  }

  /** Unified v2 RPC with a stable error model and best-effort cancellation.
   * Existing feature-specific requests remain available for older peers. */
  sendNodeUORpc(targetFeature, method, params = {}, {
    timeoutMs = 5000, idempotencyKey, expectedRevision, priority,
  } = {}) {
    if (!this.supportsNodeUO('protocol.rpc') || !this.supportsNodeUO(targetFeature)) {
      return Promise.reject(new Error('NodeUO RPC or target feature is unavailable'));
    }
    const requestId = (++this._nodeUORequestId) >>> 0 || ++this._nodeUORequestId;
    const id = `rpc.${requestId}`;
    let message;
    try {
      message = createNodeUORpcRequest({ id, targetFeature, method, params, timeoutMs,
        idempotencyKey, expectedRevision, priority,
        featureVersion: this.nodeUOFeatures.get('protocol.rpc') ?? 1 });
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._nodeUORequests.delete(id);
        try { this.sendNodeUOMessage(createNodeUORpcCancel(id, 'client timeout',
          this.nodeUOFeatures.get('protocol.rpc') ?? 1)); } catch { /* closed */ }
        const error = new Error(`NodeUO RPC timed out: ${targetFeature}.${method}`);
        error.code = 'timeout';
        reject(error);
      }, Math.max(250, Math.min(30_000, Number(timeoutMs) | 0 || 5000)));
      this._nodeUORequests.set(id, { resolve, reject, timer, namespace: 'protocol.rpc', rpc: true });
      if (!this.sendNodeUOMessage(message)) {
        clearTimeout(timer); this._nodeUORequests.delete(id);
        reject(new Error('connection is not writable'));
      }
    });
  }

  cancelNodeUORpc(requestId, reason = 'cancelled by client') {
    try { return this.sendNodeUOMessage(createNodeUORpcCancel(requestId, reason,
      this.nodeUOFeatures.get('protocol.rpc') ?? 1)); }
    catch { return false; }
  }

  sendNodeUOEvent({ channel: _channel, namespace, payload = {}, capability = null,
    kind = NodeUOChannelMessage.Event } = {}) {
    if (!this.nodeUONegotiated || (capability && !this.supportsNodeUO(capability))) return false;
    const feature = typeof capability === 'string' ? capability : featureIdForNamespace(namespace);
    const jsonKind = kind === NodeUOChannelMessage.Resume ? NodeUOJsonKind.Resume : NodeUOJsonKind.Event;
    return this.sendNodeUOMessage({ kind: jsonKind, feature,
      payload: feature === 'mods.channels' ? { namespace, data: payload } : payload });
  }

  _resolveNodeUOResponse(message) {
    if (message?.kind === NodeUOJsonKind.Progress && message.feature === 'protocol.rpc') {
      const pending = this._nodeUORequests.get(String(message.replyTo ?? ''));
      if (!pending?.rpc) return false;
      bus.emit('nodeuo:rpc-progress', { requestId: message.replyTo, ...message.payload });
      return true;
    }
    if (message?.kind === NodeUOJsonKind.Result || message?.kind === NodeUOJsonKind.Error) {
      const pending = this._nodeUORequests.get(String(message.replyTo ?? ''));
      if (!pending || pending.namespace !== message.feature) return false;
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener?.('abort', pending.abort);
      this._nodeUORequests.delete(String(message.replyTo));
      if (message.kind === NodeUOJsonKind.Error) {
        const error = new NodeUORequestError(
          message.payload?.error ?? message.payload?.message ?? 'NodeUO request failed', {
            code: message.payload?.code, details: message.payload?.details,
            retryAfterMs: message.payload?.retryAfterMs, recovery: message.payload?.recovery,
            traceId: message.traceId ?? pending.traceId,
            correlationId: message.correlationId ?? pending.correlationId,
            transactionId: message.transactionId ?? pending.transactionId,
          });
        pending.reject(error);
      } else pending.resolve(pending.rpc && message.payload?.ok === true
        ? message.payload.result : message.payload);
      return true;
    }
    if (message?.kind !== NodeUOChannelMessage.Result || !message.requestId) return false;
    const pending = this._nodeUORequests.get(message.requestId >>> 0);
    if (!pending || pending.namespace !== message.namespace) return false;
    clearTimeout(pending.timer);
    this._nodeUORequests.delete(message.requestId >>> 0);
    pending.resolve(message.payload);
    return true;
  }

  _rejectNodeUORequests(reason) {
    for (const pending of this._nodeUORequests.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener?.('abort', pending.abort);
      pending.reject(new Error(reason));
    }
    this._nodeUORequests.clear();
  }

  setNodeUOJsonHandler(handler) {
    this._nodeUOJsonHandler = typeof handler === 'function' ? handler : null;
  }

  sendNodeUOMessage(message, { beforeNegotiation = false } = {}) {
    if (!this.nodeUOJsonTransport || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (!beforeNegotiation && !this.nodeUONegotiated) return false;
    if (!beforeNegotiation && message.feature !== 'protocol.session' && !this.supportsNodeUO(message.feature)) return false;
    let normalized, text;
    try {
      normalized = createNodeUOMessage({
        ...message,
        featureVersion: message.featureVersion ?? this.nodeUOFeatures.get(message.feature) ?? 1,
      });
      text = serializeNodeUOMessage(normalized);
    }
    catch (error) { console.warn('[nodeuo-json] outgoing message rejected:', error.message); return false; }
    const byteLength = new TextEncoder().encode(text).byteLength;
    const SOFT_WATER = 1 << 19;
    const HARD_WATER = 4 << 20;
    if (this.ws.bufferedAmount + byteLength > HARD_WATER) {
      this.nodeUOJsonStats.dropped++;
      this.ws.close(1009, 'NodeUO send queue overflow');
      return false;
    }
    if (this.ws.bufferedAmount > SOFT_WATER && normalized.delivery === NodeUODelivery.LossTolerant) {
      this.nodeUOJsonStats.dropped++;
      return false;
    }
    if (this.ws.bufferedAmount > SOFT_WATER && normalized.delivery === NodeUODelivery.Latest) {
      const key = String(normalized.replace ?? `${normalized.feature}:${normalized.payload?.serial ?? ''}`);
      if (this._nodeUOJsonDeferred.has(key)) this.nodeUOJsonStats.coalesced++;
      else this.nodeUOJsonStats.deferred++;
      this._nodeUOJsonDeferred.set(key, normalized);
      this._scheduleNodeUOJsonFlush();
      return true;
    }
    this.ws.send(text);
    this.nodeUOJsonStats.sent++;
    this.nodeUOJsonStats.framesSent++;
    this.stats.bytesSent += byteLength;
    this.stats.packetsSent++;
    this.stats.lastSendAt = performance.now();
    return true;
  }

  sendNodeUOBatch(messages) {
    if (!this.nodeUOJsonTransport || !this.nodeUONegotiated || !this.ws
        || this.ws.readyState !== WebSocket.OPEN || !this.supportsNodeUO('protocol.batch')) return false;
    const active = (messages ?? []).filter((message) => !isNodeUOMessageExpired(message)
      && this.supportsNodeUO(message.feature)).map((message) => ({
      ...message,
      featureVersion: message.featureVersion ?? this.nodeUOFeatures.get(message.feature) ?? 1,
    }));
    if (!active.length) return false;
    if (active.length === 1) return this.sendNodeUOMessage(active[0]);
    let text;
    try { text = serializeNodeUOFrame(active); }
    catch { return false; }
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (this.ws.bufferedAmount + byteLength > (4 << 20)) {
      this.nodeUOJsonStats.dropped += active.length;
      this.ws.close(1009, 'NodeUO send queue overflow');
      return false;
    }
    this.ws.send(text);
    this.nodeUOJsonStats.sent += active.length;
    this.nodeUOJsonStats.framesSent++;
    this.nodeUOJsonStats.batchedMessages += active.length;
    this.stats.bytesSent += byteLength;
    this.stats.packetsSent += active.length;
    this.stats.lastSendAt = performance.now();
    return true;
  }

  _scheduleNodeUOJsonFlush() {
    if (this._nodeUOJsonFlushTimer || !this.ws) return;
    this._nodeUOJsonFlushTimer = setTimeout(() => {
      this._nodeUOJsonFlushTimer = null;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.ws.bufferedAmount > (1 << 19)) { this._scheduleNodeUOJsonFlush(); return; }
      const queued = [...this._nodeUOJsonDeferred.values()];
      this._nodeUOJsonDeferred.clear();
      const active = [];
      for (const message of queued) {
        if (isNodeUOMessageExpired(message)) { this.nodeUOJsonStats.expired++; continue; }
        active.push(message);
      }
      for (let offset = 0; offset < active.length; offset += 32) {
        const group = active.slice(offset, offset + 32);
        if (group.length < 2 || !this.sendNodeUOBatch(group)) {
          for (const message of group) this.sendNodeUOMessage(message);
        }
      }
    }, 25);
  }

  _onNodeUOJsonText(text) {
    let messages;
    try { messages = parseNodeUOFrame(text); }
    catch (error) { console.warn('[nodeuo-json] incoming message rejected:', error.message); return false; }
    this.nodeUOJsonStats.received += messages.length;
    this.nodeUOJsonStats.framesReceived++;
    if (messages.length > 1) this.nodeUOJsonStats.batchedMessages += messages.length;
    let handled = false;
    for (const message of messages) handled = this._onNodeUOJsonMessage(message) || handled;
    return handled;
  }

  _onNodeUOJsonMessage(message) {
    if (isNodeUOMessageExpired(message)) return false;
    if (message.kind === NodeUOJsonKind.Hello && message.feature === 'protocol.session') {
      const implemented = advertisedFeatureList();
      const selectedProfile = this._nodeUOProfileExplicit
        ? this.nodeUOProfile : String(message.payload?.defaultProfile ?? 'full');
      const profile = profileFeatureIds(selectedProfile, implemented);
      const schemaRows = Array.isArray(message.payload?.manifest?.features)
        ? message.payload.manifest.features : [];
      const offeredSchemas = new Map(schemaRows
        .map((entry) => [String(entry?.id), String(entry?.schema ?? '')]));
      const supported = implemented.filter((entry) => profile.includes(entry.id)
        && (!offeredSchemas.get(entry.id)
          || offeredSchemas.get(entry.id) === schemaFingerprintForFeature(entry.id)));
      const selected = negotiateFeatures(message.payload?.features, supported);
      const manifest = buildNodeUOManifest(selected);
      this._nodeUODisabledFeatures.clear();
      this.nodeUOFeatures = new Map(selected.map((entry) => [entry.id, entry.version]));
      this.nodeUOManifest = manifest;
      const accepted = createNodeUOMessage({
        kind: NodeUOJsonKind.Accept, feature: 'protocol.session', id: `accept.${Date.now()}`,
        payload: {
          protocol: 2, profile: selectedProfile, features: selected,
          manifest: { fingerprint: manifest.fingerprint,
            schemas: Object.fromEntries(manifest.features.map((entry) => [entry.id, entry.schema])) },
          client: { name: 'NodeUO Web', json: true },
        },
      });
      if (!this.sendNodeUOMessage(accepted, { beforeNegotiation: true })) {
        this.nodeUOFeatures.clear();
        this.nodeUOManifest = null;
        return false;
      }
      this.nodeUONegotiated = true;
      bus.emit('nodeuo:capabilities', {
        major: 2, minor: 0,
        features: Object.fromEntries(this.nodeUOFeatures), transport: NODEUO_JSON_SUBPROTOCOL,
      });
      return true;
    }
    if (this.nodeUONegotiated && message.kind === NodeUOJsonKind.Event
        && message.feature === 'protocol.renegotiate'
        && message.payload?.operation === 'prepare') {
      const epoch = Number(message.payload.epoch) || 0;
      const implemented = advertisedFeatureList();
      const profile = profileFeatureIds(this.nodeUOProfile, implemented);
      const offeredSchemas = new Map((message.payload?.manifest?.features ?? [])
        .map((entry) => [String(entry?.id), String(entry?.schema ?? '')]));
      const supported = implemented.filter((entry) => profile.includes(entry.id)
        && (!offeredSchemas.get(entry.id)
          || offeredSchemas.get(entry.id) === schemaFingerprintForFeature(entry.id)));
      const selected = negotiateFeatures(message.payload.features, supported);
      const manifest = buildNodeUOManifest(selected);
      void this.sendNodeUORequest({ capability: 'protocol.renegotiate', timeoutMs: 5000,
        payload: { operation: 'accept', epoch, features: selected,
          manifest: { fingerprint: manifest.fingerprint,
            schemas: Object.fromEntries(manifest.features.map((entry) => [entry.id, entry.schema])) } },
      }).then((result) => {
        if (!result?.ok || Number(result.epoch) !== epoch) return;
        this.nodeUOFeatures = new Map((result.features ?? selected)
          .map((entry) => [entry.id, entry.version]));
        this.nodeUOManifest = result.manifest ?? buildNodeUOManifest(result.features ?? selected);
        this._nodeUODisabledFeatures.clear();
        bus.emit('nodeuo:capabilities', {
          major: 2, minor: 0, renegotiated: true, epoch,
          capabilities: 0, features: Object.fromEntries(this.nodeUOFeatures),
          transport: NODEUO_JSON_SUBPROTOCOL,
        });
      }).catch((error) => console.warn('[nodeuo-json] renegotiation failed:', error.message));
      return true;
    }
    if (!this.nodeUONegotiated || !this.supportsNodeUO(message.feature)) return false;
    if (Number(message.featureVersion) > (this.nodeUOFeatures.get(message.feature) ?? 0)) return false;
    this._resolveNodeUOResponse(message);
    try { return this._nodeUOJsonHandler?.(message) !== false; }
    catch (error) {
      console.warn(`[nodeuo-json] ${message.feature} consumer failed:`, error?.message ?? error);
      if (message.feature !== 'protocol.feature-health' && this.supportsNodeUO('protocol.feature-health')) {
        this.sendNodeUOMessage({ kind: NodeUOJsonKind.Event, feature: 'protocol.feature-health',
          delivery: NodeUODelivery.Latest, replace: `feature-health:${message.feature}`,
          payload: { operation: 'report', reports: [{ feature: message.feature, status: 'failed',
            error: String(error?.message ?? error).slice(0, 256) }] } });
      }
      this._nodeUODisabledFeatures.add(message.feature);
      return false;
    }
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
      return false;
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
        return false;
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
    return true;
  }

  _onMessage(data, epoch = this.sessionEpoch.capture()) {
    if (!this.sessionEpoch.valid(epoch)) return;
    /** @type {Uint8Array} */
    let raw;
    if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (typeof data === 'string') {
      if (this.nodeUOJsonTransport) {
        this.stats.bytesReceived += new TextEncoder().encode(data).byteLength;
        this.stats.packetsReceived++;
        this.stats.lastRecvAt = performance.now();
        this._onNodeUOJsonText(data);
        return;
      }
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
