// NetState — per-connection state. Wraps a WebSocket, buffers inbound bytes,
// frames them into UO packets via @uo/protocol, and routes them to handlers.
//
// Outgoing packets are optionally Huffman-compressed (to match ServUO 1:1)
// before being sent as a binary WS frame. See config.huffmanOutgoing.
//
// One NetState may traverse multiple stages:
//   0 "loginSeed"       just connected, waiting for 0xEF seed
//   1 "accountLogin"    seed seen, waiting for 0x80
//   2 "awaitServerPick" server list sent, waiting for 0xA0
//   3 "gameLogin"       relay sent, awaiting fresh 0x91 with auth key
//   4 "charList"        0xA9 sent, awaiting 0x5D/0xF8
//   5 "inWorld"         logged in, accepting gameplay opcodes

import {
  extHouseRevision,
  frameIncoming,
  opcodeInfo,
  huffmanCompress,
  unicodeMessage,
  worldItemSA,
  removeEntity,
} from '@uo/protocol';
import {
  isNodeUOMessageExpired,
  NODEUO_JSON_SUBPROTOCOL,
  NodeUODelivery,
  NodeUOPriority,
  serializeNodeUOFrame,
  serializeNodeUOMessage,
} from '@uo/nodeuo-protocol';
import * as chatChannels from '../chat-channels.js';
import { nearbyClients } from '../world/visibility.js';
import * as diagnostics from '../systems/operational-diagnostics.js';
import { sharedPacketTemplates } from './packet-template-cache.js';
import { checkpointNodeUOResume, sendNodeUOFeature, trySendNodeUOEntityDelta, trySendNodeUOEntityRemoved } from './handlers/nodeuo-modern.js';
import { ConnectionBandwidthBudget, nodeUOTrafficClass } from './connection-bandwidth.js';

/** Convert historical script-side UI sentinels into a typed JSON command.
 * Classic UO peers receive a human-readable compatibility notice instead. */
function privateUiCommand(text) {
  if (typeof text !== 'string' || !text.startsWith('@@')) return null;
  const open = /^@@OPEN_([A-Z0-9]+)_GUMP@@([\s\S]*)$/.exec(text);
  if (open) return {
    feature: open[1] === 'CRAFT' ? 'crafting.workbench' : 'ui.rich-gumps',
    payload: { operation: 'open-gump', name: open[1].toLowerCase(), payload: open[2] },
  };
  const action = /^@@OPEN_([A-Z0-9_]+)@@([\s\S]*)$/.exec(text);
  if (action) return {
    feature: 'ui.rich-gumps',
    payload: { operation: 'open-action', name: action[1].toLowerCase(), payload: action[2] },
  };
  const progress = /^@@CRAFT_PROGRESS@@(-?\d+)\|(-?\d+)\|(-?\d+)\|([^|]*)\|([\s\S]*)$/.exec(text);
  if (progress) return {
    feature: 'crafting.workbench',
    payload: {
      operation: 'progress', recipeId: Number(progress[1]) | 0,
      done: Number(progress[2]) | 0, total: Number(progress[3]) | 0,
      status: progress[4], message: progress[5], messageEncoding: 'uri-component',
    },
  };
  return null;
}

function isPrivateUiSentinel(text) {
  return typeof text === 'string' && /^@@[A-Z0-9_]+@@/.test(text);
}

const DEFAULT_COMPATIBILITY_NOTICE = '{label} requires the NodeUO client with the negotiated {feature} feature. You can keep playing normally; only this optional enhanced interface is unavailable.{fallback}';
const PRIVATE_UI_COMPATIBILITY = Object.freeze({
  craft: ['The visual crafting workbench', 'Use the text crafting commands instead.'],
  help: ['The visual help browser', 'Use [help to list the available commands.'],
  admin: ['The visual administration panel', 'Use the standard staff commands instead.'],
  banker: ['The enhanced banking panel', 'Your standard bank box remains available.'],
  death: ['The enhanced death screen', 'Normal ghost, healer, shrine and resurrection mechanics remain available.'],
  resurrect: ['The enhanced resurrection prompt', 'Use the standard [accept or [decline response shown in your journal.'],
  house: ['The enhanced house manager', 'The standard house controls remain available.'],
  house_custom: ['The visual house designer', 'Standard housing remains available.'],
  stable: ['The enhanced stable manager', 'Use the stable master conversation and commands instead.'],
  guild: ['The enhanced guild manager', 'Use the standard guild commands instead.'],
  mappins: ['The visual map-pin editor', 'Standard maps remain available.'],
  mlquests: ['The enhanced quest journal', 'Quest conversations and journal messages remain available.'],
  imbuing: ['The visual imbuing workbench', 'Use the text workflow instead.'],
});

function compatibilityDescription(command) {
  const rawName = String(command?.payload?.name ?? '').toLowerCase();
  const [label, fallback] = PRIVATE_UI_COMPATIBILITY[rawName] ?? [];
  const readableName = rawName
    ? rawName.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'This enhanced interface';
  return {
    key: rawName ? `${command.feature}/${rawName}` : command.feature,
    label: label ?? `The ${readableName} interface`,
    fallback: fallback ?? 'The compatible standard UO gameplay path remains available.',
  };
}

function cancelTimer(handle, interval = false) {
  if (typeof handle?.cancel === 'function') return handle.cancel();
  if (handle) (interval ? clearInterval : clearTimeout)(handle);
  return false;
}

// ServUO bounds each NetState send queue. WebSocket.bufferedAmount is the
// browser/Node equivalent; an ordered game stream cannot safely drop packets,
// so disconnect a client that falls this far behind instead of retaining an
// unbounded queue for it.
export const MAX_PENDING_SEND_BYTES = 4 * 1024 * 1024;
export const SOFT_PENDING_SEND_BYTES = 1024 * 1024;
export const TCP_MAX_PENDING_SEND_BYTES = 2 * 1024 * 1024;
export const TCP_SOFT_PENDING_SEND_BYTES = 512 * 1024;
export const MAX_PENDING_RECEIVE_BYTES = 256 * 1024;
export const MAX_PACKETS_PER_TURN = 256;
export const MAX_INCOMING_PACKETS_PER_SECOND = 1024;
export const MAX_DEFERRED_COSMETIC_PACKETS = 512;
export const MAX_COSMETIC_SENDS_PER_TURN = 128;
export const COSMETIC_MAX_AGE_MS = 1000;

/** @enum {string} */
export const Stage = Object.freeze({
  LoginSeed: 'loginSeed',
  AccountLogin: 'accountLogin',
  AwaitServerPick: 'awaitServerPick',
  GameLogin: 'gameLogin',
  CharList: 'charList',
  InWorld: 'inWorld',
});

export class NetState {
  /**
   * @param {import('ws').WebSocket} ws
   * @param {object} ctx
   * @param {import('../world/world.js').World} ctx.world
   * @param {import('./auth.js').AuthKeyRegistry} ctx.authKeys
   * @param {import('../config.js').config} ctx.config
   * @param {import('./handlers.js').HandlerTable} ctx.handlers
   * @param {number} ctx.id  connection id (for logging)
   */
  constructor(ws, ctx) {
    this.ws = ws;
    this.ctx = ctx;
    this.id = ctx.id;
    this.interactionToken = `${ctx.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    this.transportKind = ws?.socket ? 'tcp' : 'websocket';
    this.backpressureLimits = this.transportKind === 'tcp'
      ? { soft: TCP_SOFT_PENDING_SEND_BYTES, hard: TCP_MAX_PENDING_SEND_BYTES }
      : { soft: SOFT_PENDING_SEND_BYTES, hard: MAX_PENDING_SEND_BYTES };
    const networkSettings = ctx.nodeUOSettings?.value?.network ?? {};
    this.nodeUOBandwidth = new ConnectionBandwidthBudget(networkSettings);
    this.stage = Stage.LoginSeed;
    /** Source IP (or `null` for in-process tests). Surfaced to handlers
     *  so AccountAttackLimiter can compose per-IP × per-account keys. */
    this.remoteAddress = ctx.remoteAddress ?? null;
    /** Private features exist only on the explicitly selected JSON
     * subprotocol. Every binary frame remains an original UO packet. */
    this.nodeUOTransportVersion = String(ctx.nodeUOTransportVersion ?? '');
    this.nodeUOJsonTransport = this.nodeUOTransportVersion === NODEUO_JSON_SUBPROTOCOL;
    this.nodeUOProtocol = null;
    this.nodeUOFeatures = new Map();
    this._nodeUOSessionOffer = null;
    this._nodeUOSessionTimer = null;
    /** @type {string | null} */
    this.accountName = null;
    /** @type {import('./accounts.js').Account | null} */
    this.account = null;
    /** @type {number} */
    this.seed = 0;
    /** @type {string | null} */
    this.clientVersionString = null;
    /** @type {{ major:number, minor:number, revision:number, patch:number } | null} */
    this.clientVersion = null;
    /** DropReq is 15 bytes for >=6.0.1.7 clients, 14 bytes before that. */
    this.dropReqSize = 15;
    /** @type {import('../world/world.js').Mobile | null} */
    this.mobile = null;
    /** @type {import('../world/items.js').Item | null} */
    this.heldItem = null;
    /** Serials of containers this client currently has open — filters 0x25 updates. @type {Set<number>} */
    this.openContainers = new Set();
    /** @type {Uint8Array} */
    this._rx = new Uint8Array(0);
    this._rxDrainScheduled = false;
    this._packetWindowStarted = performance.now();
    this._packetWindowCount = 0;
    this._closed = false;
    this._closing = false;
    this._cleanupDone = false;
    this.roundTripMs = null;
    this._rttPingSentAt = 0;
    this._rttTimer = null;
    this._deferredCosmetic = new Map();
    this._cosmeticFlushTimer = null;
    this._lastEntityDelta = new Map();
    /** Last advertised classic custom-house revision by foundation serial. */
    this._houseRevisions = new Map();
    this._nodeUOJsonDeferred = new Map();
    this._nodeUOJsonReliableQueue = [];
    this._nodeUOJsonReliableHead = 0;
    this._nodeUOJsonReliableBytes = 0;
    this._nodeUOJsonFlushTimer = null;
    this.nodeUOJsonStats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0,
      deferred: 0, coalesced: 0, dropped: 0, expired: 0, rejected: 0,
      framesSent: 0, framesReceived: 0, batchedMessages: 0, reliableQueued: 0 };
    this.backpressureStats = { deferred: 0, coalesced: 0, flushed: 0, dropped: 0,
      staleDropped: 0, cappedTurns: 0, totalWaitMs: 0, maxWaitMs: 0, duplicateDeltas: 0 };
    this._admissionAcquired = ctx.admission?.acquire?.(this.id) ?? true;
    if (!this._admissionAcquired) {
      this._closed = true;
      this._closing = true;
      try { ws.close(1013, 'server overloaded'); } catch { /* transport may already be gone */ }
      return;
    }
    this.ctx.connections?.add?.(this);
    diagnostics.connectionOpened(this);

    ws.binaryType = 'arraybuffer';
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (!this.nodeUOJsonTransport) return;
        const text = typeof data === 'string' ? data : data?.toString?.('utf8');
        if (typeof text !== 'string') return;
        this.nodeUOJsonStats.received++;
        this.nodeUOJsonStats.framesReceived++;
        this.nodeUOJsonStats.bytesReceived += Buffer.byteLength(text);
        this.ctx.handleNodeUOText?.(this, text);
        return;
      }
      this._feed(new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.length));
    });
    ws.on('close', (code, reason) => {
      // Capture WHY the WS closed. RFC 6455 close codes:
      //   1000 normal      1001 going-away   1002 protocol-error
      //   1006 abnormal    1008 policy-vio   1011 server-error
      // `1006` (abnormal closure) is the typical browser-side timeout
      // / network drop — user closed tab, OS suspended, ISP flap, etc.
      // Reason is a Buffer; toString gives any server-supplied detail.
      const reasonStr = reason && reason.length > 0
        ? (typeof reason === 'string' ? reason : reason.toString('utf8'))
        : '(none)';
      console.log(`[net#${this.id}] ws close code=${code} reason=${reasonStr}`);
      this._onClose();
    });
    ws.on('error', (err) => {
      // Always log WS errors — these point at protocol corruption,
      // payload-too-large, or socket-level failures that precede a close.
      console.warn(`[net#${this.id}] ws error: ${err?.message ?? err} (${err?.code ?? '?'})`);
    });
    // WebSocket control-frame RTT is transport metadata, not a custom UO
    // opcode. Desktop/TCP clients remain byte-for-byte standard and simply
    // expose ping as unavailable in the admin inspector.
    if (typeof ws.ping === 'function') {
      ws.on('pong', () => {
        if (!this._rttPingSentAt) return;
        const sample = Math.max(0, performance.now() - this._rttPingSentAt);
        this.roundTripMs = this.roundTripMs == null ? sample : this.roundTripMs * 0.75 + sample * 0.25;
        this._rttPingSentAt = 0;
        diagnostics.connectionUpdated(this);
      });
      const ping = () => {
        if (this._closed || this.ws.readyState !== 1 || this._rttPingSentAt) return;
        this._rttPingSentAt = performance.now();
        try { this.ws.ping(); } catch { this._rttPingSentAt = 0; }
      };
      this._rttTimer = ctx.scheduler?.every
        ? ctx.scheduler.every(`net-rtt:${this.id}`, 10_000, ping)
        : setInterval(ping, 10_000);
      this._rttTimer.unref?.();
    }
  }

  /**
   * Append bytes to the rx buffer and frame as many complete packets as possible.
   * @param {Uint8Array} chunk
   */
  _feed(chunk) {
    if (this._closed) return;
    // Append.
    // The common case is one or more complete packets in a fresh transport
    // read. Reuse that view directly; allocate only when a prior partial
    // packet really has to be joined with new bytes.
    let merged;
    if (this._rx.length === 0) {
      merged = chunk;
    } else if (chunk.length === 0) {
      merged = this._rx;
    } else {
      merged = new Uint8Array(this._rx.length + chunk.length);
      merged.set(this._rx);
      merged.set(chunk, this._rx.length);
    }
    // Bug-hunt #11 #3 (DoS): cap accumulated unframed bytes. A malicious
    // client could open a variable-length packet header with size=0xFFFF
    // and never send the payload, pinning ~64KB per repeat forever.
    // 256 KB is comfortably larger than any single UO packet (largest
    // known is ~12 KB for full house customisation).
    if (merged.length > MAX_PENDING_RECEIVE_BYTES) {
      console.warn(`[net#${this.id}] rx overflow ${merged.length}B → forcing close`);
      this._rx = new Uint8Array(0);
      try { this.close?.(); } catch { /* ignore */ }
      return;
    }
    this._rx = merged;
    // A prior coalesced frame hit the per-turn budget. Keep accumulating up
    // to the hard byte cap and let the scheduled continuation drain it; this
    // prevents a burst of WS/TCP events from bypassing the fairness budget.
    if (this._rxDrainScheduled) return;

    let packets = [];
    let consumed = 0;
    let limited = false;
    try {
      ({ packets, consumed, limited } = frameIncoming(merged, {
        dropReqSize: this.dropReqSize,
        maxPackets: MAX_PACKETS_PER_TURN,
      }));
      this._rx = merged.subarray(consumed);
    } catch (e) {
      const offRaw = (typeof e.offset === 'number' && e.offset >= 0) ? e.offset : -1;
      if (offRaw < 0) {
        console.warn(`[net#${this.id}] protocol error: ${e.message} — dropping connection`);
        diagnostics.protocolError();
        this.close('protocol error');
        return;
      }

      // `ingame=false` follows ServUO semantics: the handler does not
      // REQUIRE a logged-in Mobile. It does not mean the packet becomes
      // illegal after login. In particular PingReq (0x73) remains valid in
      // world, so never strip opcodes based on that flag.
      //
      // Preserve the already-framed prefix. A byte-wise scan for the next
      // plausible opcode is unsafe because ordinary payload bytes often look
      // like opcodes and can consume subsequent movement packets at the wrong
      // boundary. Discard the malformed remainder of this receive batch and
      // resume cleanly with the next batch.
      packets = Array.isArray(e.packets) ? e.packets : [];
      consumed = typeof e.consumed === 'number' ? e.consumed : offRaw;
      const start = Math.max(0, offRaw - 16);
      const end = Math.min(merged.length, offRaw + 32);
      const hex = Array.from(merged.subarray(start, end))
        .map((b, i) => ((start + i) === offRaw ? '>' : '') + b.toString(16).padStart(2, '0'))
        .join(' ');
      console.warn(
        `[net#${this.id}] protocol error: ${e.message} at rx[${offRaw}] of ${merged.length} bytes; window=${hex} — dispatched ${packets.length} valid prefix packet(s), discarded malformed tail`,
      );
      diagnostics.protocolError();
      this._rx = new Uint8Array(0);
    }

    const packetNow = performance.now();
    if ((packetNow - this._packetWindowStarted) >= 1000) {
      this._packetWindowStarted = packetNow;
      this._packetWindowCount = 0;
    }
    this._packetWindowCount += packets.length;
    if (this._packetWindowCount > MAX_INCOMING_PACKETS_PER_SECOND) {
      console.warn(`[net#${this.id}] packet flood ${this._packetWindowCount}/s → closing`);
      diagnostics.protocolError();
      this.close('packet rate overflow');
      return;
    }

    for (const pkt of packets) {
      const op = pkt[0];
      diagnostics.recordPacketReplay('rx', pkt, this);
      diagnostics.recordSimulationInput(this, pkt);
      const info = opcodeInfo(op);
      if (this.ctx.config.logPackets) {
        console.log(`[net#${this.id}] << 0x${op.toString(16).padStart(2, '0')} ${info?.name ?? '?'} (${pkt.length} bytes) stage=${this.stage}`);
      }
      const handler = this.ctx.handlers[op];
      if (!handler) {
        // Unknown-but-registered opcode. Just log and skip.
        console.warn(`[net#${this.id}] no handler for 0x${op.toString(16)} (${info?.name})`);
        diagnostics.packet('rx', op, pkt.length, 0, true, this);
        continue;
      }
      const startedAt = performance.now();
      try {
        handler(this, pkt);
        diagnostics.packet('rx', op, pkt.length, performance.now() - startedAt, false, this);
      } catch (e) {
        // Gameplay handlers can throw on edge-case data (mis-formed packets,
        // bugs in script-registered commands, etc.). Losing the entire
        // connection for any of those is too harsh — just log and keep
        // going so the player doesn't get kicked mid-command. If the
        // session is genuinely broken, subsequent ops will fail too.
        console.error(`[net#${this.id}] handler 0x${op.toString(16)} threw:`, e);
        diagnostics.packet('rx', op, pkt.length, performance.now() - startedAt, true, this);
        diagnostics.handlerError();
      }
    }

    if (limited && this._rx.length > 0 && !this._closed) {
      this._rxDrainScheduled = true;
      setImmediate(() => {
        this._rxDrainScheduled = false;
        this._feed(new Uint8Array(0));
      });
    }
  }

  /**
   * Send a pre-built UO packet. Applies outgoing Huffman if enabled,
   * but ONLY for the game-phase stages (CharList / InWorld) — the
   * login-phase responses (0xA8 ServerList, 0x8C Relay) MUST go out
   * uncompressed per the canonical ServUO/CUO behaviour. ClassicUO
   * desktop only enables its Huffman decoder after sending 0x91
   * GameLogin; if our server compresses 0xA8 the desktop client sees
   * garbage and hangs on "Verifying Account…" forever (Marcin's
   * symptom). The browser client auto-probes either mode so it works
   * with both — desktop CUO can't.
   *
   * @param {Uint8Array} packet
   */
  send(packet, { priority = 'normal', coalesceKey = null } = {}) {
    if (this._closed || this.ws.readyState !== 1 /* OPEN */) return;
    const pending = Number(this.ws.bufferedAmount) || 0;
    if (pending > this.backpressureLimits.hard) {
      console.warn(`[net#${this.id}] slow client buffered ${pending}B → closing`);
      this.close('send queue overflow');
      return;
    }
    if (priority === 'cosmetic'
        && this.ctx.admission?.shouldDropCosmetic?.(pending, this.backpressureLimits.soft)) {
      this.backpressureStats.dropped++;
      return;
    }
    if (priority === 'cosmetic' && pending > this.backpressureLimits.soft) {
      const key = String(coalesceKey ?? `opcode:${packet[0]}`);
      if (this._deferredCosmetic.has(key)) this.backpressureStats.coalesced++;
      else this.backpressureStats.deferred++;
      this._deferredCosmetic.set(key, { packet: packet.slice(), queuedAt: performance.now() });
      while (this._deferredCosmetic.size > MAX_DEFERRED_COSMETIC_PACKETS) {
        this._deferredCosmetic.delete(this._deferredCosmetic.keys().next().value);
        this.backpressureStats.dropped++;
      }
      this._scheduleCosmeticFlush();
      return;
    }
    if (this.ctx.config.logPackets) {
      console.log(`[net#${this.id}] >> 0x${packet[0].toString(16).padStart(2, '0')} (${packet.length} bytes) stage=${this.stage}`);
    }
    const inGamePhase = this.stage === Stage.CharList || this.stage === Stage.InWorld;
    const useHuffman = this.ctx.config.huffmanOutgoing && inGamePhase;
    const payload = useHuffman ? huffmanCompress(packet) : packet;
    this.ws.send(payload, { binary: true, compress: false });
    diagnostics.recordPacketReplay('tx', packet, this);
    diagnostics.packet('tx', packet[0], payload.length, 0, false, this);
    diagnostics.connectionUpdated(this);
  }

  sendCosmetic(packet, coalesceKey = null) {
    return this.send(packet, { priority: 'cosmetic', coalesceKey });
  }

  /** Send one NodeUO v2 text envelope. This never writes to raw TCP and never
   * puts private bytes inside the UO opcode stream. */
  sendNodeUOMessage(message, { allowBeforeNegotiation = false } = {}) {
    if (!this.nodeUOJsonTransport || this._closed || this.ws.readyState !== 1) return false;
    if (!allowBeforeNegotiation && !this.nodeUOProtocol) return false;
    if (!allowBeforeNegotiation && message?.feature !== 'protocol.session'
        && !this.supportsNodeUO(message?.feature)) return false;
    const costStarted = performance.now();
    if (isNodeUOMessageExpired(message)) {
      this.nodeUOJsonStats.expired++;
      return this._recordNodeUOCost(message?.feature, 0, costStarted, 'rejected', false);
    }
    let text;
    try { text = serializeNodeUOMessage(message); }
    catch (error) {
      this.nodeUOJsonStats.rejected++;
      if (this.ctx.config?.logPackets) console.warn(`[net#${this.id}] NodeUO JSON rejected: ${error.message}`);
      return this._recordNodeUOCost(message?.feature, 0, costStarted, 'rejected', false);
    }
    const pending = Number(this.ws.bufferedAmount) || 0;
    if (pending + Buffer.byteLength(text) > this.backpressureLimits.hard) {
      this.close('NodeUO send queue overflow');
      return this._recordNodeUOCost(message?.feature, Buffer.byteLength(text), costStarted, 'dropped', false);
    }
    const delivery = message.delivery ?? NodeUODelivery.Reliable;
    const priority = message.priority ?? NodeUOPriority.Normal;
    const textBytes = Buffer.byteLength(text);
    const trafficClass = nodeUOTrafficClass(message);
    if (delivery === NodeUODelivery.Reliable && priority !== NodeUOPriority.Critical
        && this._nodeUOJsonReliableHead < this._nodeUOJsonReliableQueue.length) {
      const queued = this._queueNodeUOReliable({ text, bytes: textBytes, count: 1, trafficClass });
      return this._recordNodeUOCost(message.feature, textBytes, costStarted, queued ? 'deferred' : 'dropped', queued);
    }
    let budgetDecision = this.nodeUOBandwidth.admit(textBytes, {
      trafficClass, delivery,
    });
    if (budgetDecision === 'allow') {
      budgetDecision = this.ctx.globalTrafficGovernor?.admit?.(this.id, textBytes, { trafficClass, delivery }) ?? 'allow';
    }
    if (budgetDecision === 'drop') {
      this.nodeUOJsonStats.dropped++;
      return this._recordNodeUOCost(message.feature, textBytes, costStarted, 'dropped', false);
    }
    if (pending > this.backpressureLimits.soft
        && (delivery === NodeUODelivery.LossTolerant || priority === NodeUOPriority.Background)) {
      this.nodeUOJsonStats.dropped++;
      return this._recordNodeUOCost(message.feature, textBytes, costStarted, 'dropped', false);
    }
    if ((pending > this.backpressureLimits.soft || budgetDecision === 'defer')
        && delivery === NodeUODelivery.Latest) {
      const key = String(message.replace ?? `${message.feature}:${message.payload?.serial ?? message.payload?.target ?? ''}`);
      if (this._nodeUOJsonDeferred.has(key)) this.nodeUOJsonStats.coalesced++;
      else this.nodeUOJsonStats.deferred++;
      this._nodeUOJsonDeferred.set(key, { message, queuedAt: Date.now() });
      this._scheduleNodeUOJsonFlush();
      return this._recordNodeUOCost(message.feature, textBytes, costStarted, 'deferred', true);
    }
    if (budgetDecision === 'defer' && delivery === NodeUODelivery.Reliable) {
      const queued = this._queueNodeUOReliable({ text, bytes: textBytes, count: 1, trafficClass });
      return this._recordNodeUOCost(message.feature, textBytes, costStarted, queued ? 'deferred' : 'dropped', queued);
    }
    const sent = this._writeNodeUOText(text, textBytes, 1);
    return this._recordNodeUOCost(message.feature, textBytes, costStarted, sent ? 'handled' : 'dropped', sent);
  }

  _recordNodeUOCost(feature, bytes, started, outcome, result) {
    this.ctx.protocolCosts?.record?.(feature, 'outbound', {
      bytes, ms: performance.now() - started, outcome,
    });
    return result;
  }

  /** Send a bounded group in one JSON text frame. Every member remains an
   * independently versioned/validated envelope. */
  sendNodeUOBatch(messages) {
    if (!this.nodeUOJsonTransport || !this.nodeUOProtocol || this._closed
        || this.ws.readyState !== 1 || !this.supportsNodeUO('protocol.batch')) return false;
    const active = (messages ?? []).filter((message) => !isNodeUOMessageExpired(message)
      && (message.feature === 'protocol.session' || this.supportsNodeUO(message.feature)));
    if (!active.length) return false;
    if (active.length === 1) return this.sendNodeUOMessage(active[0]);
    const costStarted = performance.now();
    let text;
    try { text = serializeNodeUOFrame(active); }
    catch { return this._recordNodeUOBatchCost(active, 0, costStarted, 'error', false); }
    const bytes = Buffer.byteLength(text);
    if ((Number(this.ws.bufferedAmount) || 0) + bytes > this.backpressureLimits.hard) {
      this.close('NodeUO send queue overflow');
      return this._recordNodeUOBatchCost(active, bytes, costStarted, 'dropped', false);
    }
    const reliable = active.some((message) => (message.delivery ?? NodeUODelivery.Reliable) === NodeUODelivery.Reliable);
    const trafficClass = active.some((message) => message.priority === NodeUOPriority.Critical)
      ? 'critical' : active.some((message) => message.priority === NodeUOPriority.High) ? 'interactive' : 'state';
    if (reliable && trafficClass !== 'critical'
        && this._nodeUOJsonReliableHead < this._nodeUOJsonReliableQueue.length) {
      const queued = this._queueNodeUOReliable({ text, bytes, count: active.length, trafficClass });
      return this._recordNodeUOBatchCost(active, bytes, costStarted, queued ? 'deferred' : 'dropped', queued);
    }
    let decision = this.nodeUOBandwidth.admit(bytes, {
      trafficClass, delivery: reliable ? NodeUODelivery.Reliable : NodeUODelivery.Latest,
    });
    if (decision === 'allow') decision = this.ctx.globalTrafficGovernor?.admit?.(this.id, bytes, {
      trafficClass, delivery: reliable ? NodeUODelivery.Reliable : NodeUODelivery.Latest,
    }) ?? 'allow';
    if (decision === 'defer' && reliable) {
      const queued = this._queueNodeUOReliable({ text, bytes, count: active.length, trafficClass });
      return this._recordNodeUOBatchCost(active, bytes, costStarted, queued ? 'deferred' : 'dropped', queued);
    }
    if (decision !== 'allow') return this._recordNodeUOBatchCost(active, bytes, costStarted, 'dropped', false);
    const sent = this._writeNodeUOText(text, bytes, active.length);
    return this._recordNodeUOBatchCost(active, bytes, costStarted, sent ? 'handled' : 'dropped', sent);
  }

  _recordNodeUOBatchCost(messages, bytes, started, outcome, result) {
    const count = Math.max(1, messages.length);
    const baseBytes = Math.floor(bytes / count);
    const remainder = bytes - baseBytes * count;
    const elapsed = (performance.now() - started) / count;
    for (let index = 0; index < messages.length; index++) {
      this.ctx.protocolCosts?.record?.(messages[index]?.feature, 'outbound', {
        bytes: baseBytes + (index < remainder ? 1 : 0), ms: elapsed, outcome,
      });
    }
    return result;
  }

  _writeNodeUOText(text, bytes, count = 1) {
    if (this._closed || this.ws.readyState !== 1) return false;
    this.ws.send(text, { binary: false, compress: text.length > 1024 });
    this.nodeUOJsonStats.sent += count;
    this.nodeUOJsonStats.framesSent++;
    if (count > 1) this.nodeUOJsonStats.batchedMessages += count;
    this.nodeUOJsonStats.bytesSent += bytes;
    diagnostics.connectionUpdated(this);
    return true;
  }

  _queueNodeUOReliable(row) {
    if (this._closed) return false;
    const pending = (Number(this.ws.bufferedAmount) || 0) + this._nodeUOJsonReliableBytes + row.bytes;
    if (pending > this.backpressureLimits.hard) {
      this.close('NodeUO reliable queue overflow');
      return false;
    }
    // Keep dequeue O(1). Compact only occasionally so a throttled connection
    // cannot make every reliable frame pay Array#shift's linear copy cost.
    if (this._nodeUOJsonReliableHead >= 256
        && this._nodeUOJsonReliableHead * 2 >= this._nodeUOJsonReliableQueue.length) {
      this._nodeUOJsonReliableQueue = this._nodeUOJsonReliableQueue
        .slice(this._nodeUOJsonReliableHead);
      this._nodeUOJsonReliableHead = 0;
    }
    this._nodeUOJsonReliableQueue.push(row);
    this._nodeUOJsonReliableBytes += row.bytes;
    this.nodeUOJsonStats.deferred += row.count;
    this.nodeUOJsonStats.reliableQueued += row.count;
    this._scheduleNodeUOJsonFlush();
    return true;
  }

  _scheduleNodeUOJsonFlush() {
    if (this._nodeUOJsonFlushTimer || this._closed) return;
    const flush = () => {
      this._nodeUOJsonFlushTimer = null;
      if (this._closed || this.ws.readyState !== 1) return;
      if ((Number(this.ws.bufferedAmount) || 0) > this.backpressureLimits.soft) {
        this._scheduleNodeUOJsonFlush();
        return;
      }
      while (this._nodeUOJsonReliableHead < this._nodeUOJsonReliableQueue.length) {
        const row = this._nodeUOJsonReliableQueue[this._nodeUOJsonReliableHead];
        let decision = this.nodeUOBandwidth.admit(row.bytes, {
          trafficClass: row.trafficClass ?? 'state', delivery: NodeUODelivery.Reliable,
        });
        if (decision === 'allow') decision = this.ctx.globalTrafficGovernor?.admit?.(this.id, row.bytes, {
          trafficClass: row.trafficClass ?? 'state', delivery: NodeUODelivery.Reliable,
        }) ?? 'allow';
        if (decision !== 'allow') {
          this._scheduleNodeUOJsonFlush();
          return;
        }
        this._nodeUOJsonReliableHead++;
        this._nodeUOJsonReliableBytes -= row.bytes;
        if (!this._writeNodeUOText(row.text, row.bytes, row.count)) return;
      }
      this._nodeUOJsonReliableQueue.length = 0;
      this._nodeUOJsonReliableHead = 0;
      const queued = [...this._nodeUOJsonDeferred.values()];
      this._nodeUOJsonDeferred.clear();
      const active = [];
      for (const row of queued) {
        if (isNodeUOMessageExpired(row.message)) { this.nodeUOJsonStats.expired++; continue; }
        active.push(row.message);
      }
      for (let offset = 0; offset < active.length; offset += 32) {
        const group = active.slice(offset, offset + 32);
        if (group.length < 2 || !this.sendNodeUOBatch(group)) {
          for (const message of group) this.sendNodeUOMessage(message);
        }
      }
    };
    this._nodeUOJsonFlushTimer = this.ctx.scheduler?.once
      ? this.ctx.scheduler.once(`nodeuo-json:${this.id}`, 25, flush)
      : setTimeout(flush, 25);
    this._nodeUOJsonFlushTimer.unref?.();
  }

  /** Encode several already-built UO packets into one transport write. Packet
   * boundaries remain in the UO byte stream; only WS/syscall overhead changes. */
  sendBatch(packets) {
    const rows = (packets ?? []).filter((packet) => packet?.length);
    if (rows.length === 0) return false;
    if (rows.length === 1) { this.send(rows[0]); return true; }
    if (this._closed || this.ws.readyState !== 1) return false;
    const pending = Number(this.ws.bufferedAmount) || 0;
    const bytes = rows.reduce((sum, packet) => sum + packet.length, 0);
    if (pending + bytes > this.backpressureLimits.hard) {
      this.close('send queue overflow');
      return false;
    }
    const inGamePhase = this.stage === Stage.CharList || this.stage === Stage.InWorld;
    const useHuffman = this.ctx.config.huffmanOutgoing && inGamePhase;
    if (!useHuffman && typeof this.ws.sendBatch === 'function') {
      // Raw TCP can pass the packet views to Node's cork/_writev path. UO
      // framing remains byte-for-byte identical and Buffer.concat disappears.
      this.ws.sendBatch(rows);
    } else {
      const joined = Buffer.concat(
        rows.map((packet) => Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength)), bytes,
      );
      const payload = useHuffman ? huffmanCompress(joined) : joined;
      this.ws.send(payload, { binary: true, compress: false });
    }
    for (const packet of rows) {
      diagnostics.recordPacketReplay('tx', packet, this);
      diagnostics.packet('tx', packet[0], packet.length, 0, false, this);
    }
    diagnostics.connectionUpdated(this);
    return true;
  }

  /** Send the latest authoritative state for one entity. Identical deltas
   * are suppressed per viewer; under socket pressure the existing cosmetic
   * queue keeps only the newest packet for the same entity/field mask. */
  sendEntityDelta(serialLike, fieldMask, packet) {
    const serial = Number(serialLike) >>> 0;
    if (!serial || !packet?.length) return this.send(packet);
    if (trySendNodeUOEntityDelta(this, serial, fieldMask)) return true;
    let signature = 2166136261;
    for (let index = 0; index < packet.length; index++) {
      signature ^= packet[index];
      signature = Math.imul(signature, 16777619);
    }
    signature >>>= 0;
    const key = `${serial}:${Number(fieldMask) >>> 0}`;
    if (this._lastEntityDelta.get(key) === signature) {
      this.backpressureStats.duplicateDeltas++;
      return false;
    }
    this._lastEntityDelta.delete(key);
    this._lastEntityDelta.set(key, signature);
    while (this._lastEntityDelta.size > 4096) this._lastEntityDelta.delete(this._lastEntityDelta.keys().next().value);
    this.sendCosmetic(packet, `entity:${key}`);
    return true;
  }

  _scheduleCosmeticFlush() {
    if (this._cosmeticFlushTimer || this._closed) return;
    const flush = () => {
      this._cosmeticFlushTimer = null;
      if (this._closed || this.ws.readyState !== 1) return;
      if ((Number(this.ws.bufferedAmount) || 0) > this.backpressureLimits.soft) {
        this._scheduleCosmeticFlush();
        return;
      }
      const now = performance.now();
      const pending = [...this._deferredCosmetic.entries()];
      let sent = 0;
      const batch = [];
      for (const [key, row] of pending) {
        const wait = now - row.queuedAt;
        if (wait > COSMETIC_MAX_AGE_MS) {
          this._deferredCosmetic.delete(key);
          this.backpressureStats.dropped++;
          this.backpressureStats.staleDropped++;
          continue;
        }
        if (sent >= MAX_COSMETIC_SENDS_PER_TURN) {
          this.backpressureStats.cappedTurns++;
          break;
        }
        this._deferredCosmetic.delete(key);
        this.backpressureStats.totalWaitMs += wait;
        this.backpressureStats.maxWaitMs = Math.max(this.backpressureStats.maxWaitMs, wait);
        this.backpressureStats.flushed++;
        batch.push(row.packet);
        sent++;
      }
      if (batch.length) this.sendBatch(batch);
      if (this._deferredCosmetic.size) this._scheduleCosmeticFlush();
    };
    this._cosmeticFlushTimer = this.ctx.scheduler?.once
      ? this.ctx.scheduler.once(`net-cosmetic:${this.id}`, 25, flush)
      : setTimeout(flush, 25);
    this._cosmeticFlushTimer.unref?.();
  }

  backpressureSnapshot() {
    const stats = this.backpressureStats;
    return { ...stats, transport: this.transportKind, limits: { ...this.backpressureLimits },
      pendingBytes: Number(this.ws?.bufferedAmount) || 0,
      averageWaitMs: stats.flushed ? Number((stats.totalWaitMs / stats.flushed).toFixed(3)) : 0 };
  }

  close(reason) {
    if (this._closing || this._cleanupDone) return;
    this._closing = true;
    this._closed = true;
    try { this.ws.close(1000, reason); } catch { /* ignore */ }
    // WebSocket 'close' can be delayed (or never arrive for a broken
    // adapter). Run cleanup now; the eventual event is idempotent.
    this._onClose();
  }

  /** Convenience: push a system message to this client. Accepts an
   *  optional hue (defaults to the standard system grey via the
   *  protocol helper). Pass `0x59` for the blue skill-advance line
   *  ServUO/CUO render in the journal. */
  sendSystemMessage(text, hue) {
    const command = privateUiCommand(text);
    if (command) {
      if (this.nodeUOJsonTransport && this.nodeUOProtocol?.major === 2
          && sendNodeUOFeature(this, command)) return;
      const description = compatibilityDescription(command);
      this.notifyNodeUORequirement(description.key, description);
      return;
    } else if (isPrivateUiSentinel(text)) {
      this.notifyNodeUORequirement('ui.unknown-private-marker', {
        label: 'This enhanced interface',
        fallback: 'The compatible standard UO gameplay path remains available.',
      });
      return;
    }
    if (hue == null) this.send(unicodeMessage({ text }));
    else this.send(unicodeMessage({ text, hue }));
  }

  /** Tell a classic/incompatible client that an optional visual feature is
   * unavailable without turning repeated progress markers into journal/log
   * spam. Core gameplay fallbacks are owned by the calling system and are not
   * changed by this notice. */
  notifyNodeUORequirement(feature, { label, fallback } = {}) {
    if (this._closed) return false;
    const key = String(feature ?? 'enhanced-ui').toLowerCase().slice(0, 160);
    const settings = this.ctx.nodeUOSettings?.value?.compatibility ?? {};
    if (settings.noticesEnabled === false) {
      diagnostics.compatibilityNotice(key, false);
      return false;
    }
    const now = Date.now();
    const cooldownMs = Math.max(5_000, Math.min(60 * 60_000,
      Number(settings.noticeCooldownMs) || 300_000));
    this._nodeUOCompatibilityNotices ??= new Map();
    const lastShownAt = this._nodeUOCompatibilityNotices.get(key) ?? 0;
    if ((now - lastShownAt) < cooldownMs) {
      diagnostics.compatibilityNotice(key, false);
      return false;
    }
    this._nodeUOCompatibilityNotices.delete(key);
    this._nodeUOCompatibilityNotices.set(key, now);
    while (this._nodeUOCompatibilityNotices.size > 64) {
      this._nodeUOCompatibilityNotices.delete(this._nodeUOCompatibilityNotices.keys().next().value);
    }

    const fallbackText = String(fallback ?? '').trim();
    const template = String(settings.noticeTemplate ?? DEFAULT_COMPATIBILITY_NOTICE);
    const message = template
      .replaceAll('{feature}', key)
      .replaceAll('{label}', String(label ?? 'This enhanced interface').trim())
      .replaceAll('{fallback}', fallbackText ? ` ${fallbackText}` : '')
      .slice(0, 1000);
    this.send(unicodeMessage({ text: message, hue: 0x03b2 }));
    diagnostics.compatibilityNotice(key, true);
    const safeLog = (value, fallbackValue) => String(value ?? fallbackValue)
      .replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 160);
    console.info(`[compat#${this.id}] optional NodeUO feature unavailable; account=${safeLog(this.accountName, '-')} client=${safeLog(this.clientVersionString, 'unknown')} transport=${safeLog(this.nodeUOTransportVersion || this.transportKind, 'unknown')} feature=${safeLog(key, 'unknown')}; standard UO session continues`);
    return true;
  }

  /** Convenience: emit a 0xF3 WorldItemSA for an item. */
  packetForItem(item) {
    if (!item || item.visible === false) {
      if (item?.serial != null && this._visibleItems?.has?.(item.serial >>> 0)) {
        this.sendRemove(item.serial);
        this._visibleItems.delete(item.serial >>> 0);
      }
      return null;
    }
    // Propagate `item.movable` into the on-wire flags byte. The default
    // worldItemSA flag is 0x20 ("movable" in our protocol, despite a
    // misleading comment that calls 0x20 hidden). Without this branch
    // every door / sign / decoration was broadcast as movable, so the
    // client treated single-clicks on them as drag-pickups → 0x07 →
    // server rejected (item not movable) → "You cannot pick that up"
    // spam on every door click. Match the existing convention used by
    // `_onClose` (line 219) — 0x20 movable, 0x00 fixed.
    const isMulti = item._multiAnchor === true || item.multiId != null || item.boat != null;
    const itemId = isMulti ? (item.multiId ?? item.itemId) : item.itemId;
    const flags = item.movable === false ? 0x00 : 0x20;
    const key = `item:${item.serial >>> 0}:${itemId | 0}:${item.hue | 0}:${item.amount | 0}:${item.x | 0}:${item.y | 0}:${item.z | 0}:${flags}:${isMulti ? 2 : 0}`;
    return sharedPacketTemplates.get(key, () => worldItemSA({
      serial: item.serial, itemId, dataType: isMulti ? 2 : 0,
      hue: item.hue, amount: item.amount, x: item.x, y: item.y, z: item.z, flags,
    }));
  }

  sendItem(item) {
    const packet = this.packetForItem(item);
    if (!packet) return false;
    this.send(packet);
    // Standard clients discover custom designs through BF/1D and answer with
    // BF/1E. Advertise only when a foundation first enters visibility or its
    // revision changes; ordinary static houses and boats pay no extra packet.
    if (item?._multiAnchor === true || item?.multiId != null) {
      const houses = this.ctx.houses ?? this.ctx.systems?.houses;
      const house = houses?.houseByMultiSerial?.(item.serial) ?? null;
      if (house?.customizable) {
        const serial = item.serial >>> 0;
        const revision = house.revision >>> 0;
        if (this._houseRevisions.get(serial) !== revision) {
          this._houseRevisions.set(serial, revision);
          this.send(extHouseRevision({ serial, revision }));
        }
      }
    }
    return true;
  }

  supportsNodeUO(capability) {
    if (!this.nodeUOJsonTransport || this.nodeUOProtocol?.major !== 2
        || typeof capability !== 'string') return false;
    const feature = capability.trim().toLowerCase();
    return !!feature && !this._nodeUODisabledFeatures?.has?.(feature)
      && this.nodeUOFeatures.has(feature)
      && this.ctx.featureRollouts?.allowed?.(this, feature) !== false;
  }

  /** Convenience: emit 0x1D RemoveEntity for a serial. */
  sendRemove(serial) {
    const prefix = `${Number(serial) >>> 0}:`;
    for (const key of this._lastEntityDelta.keys()) if (key.startsWith(prefix)) this._lastEntityDelta.delete(key);
    const normalized = Number(serial) >>> 0;
    this._houseRevisions.delete(normalized);
    if (!trySendNodeUOEntityRemoved(this, normalized)) {
      this.send(sharedPacketTemplates.get(`remove:${normalized}`, () => removeEntity(normalized)));
    }
  }

  _onClose() {
    if (this._cleanupDone) return;
    this._cleanupDone = true;
    checkpointNodeUOResume(this);
    this.ctx.cleanupNodeUOFeatureState?.(this);
    this.ctx.connections?.delete?.(this);
    if (this._admissionAcquired) this.ctx.admission?.release?.(this.id);
    this._admissionAcquired = false;
    this.ctx.world?.clearPropertyObserver?.(this);
    cancelTimer(this._rttTimer, true);
    this._rttTimer = null;
    cancelTimer(this._cosmeticFlushTimer);
    this._cosmeticFlushTimer = null;
    cancelTimer(this._nodeUOJsonFlushTimer);
    this._nodeUOJsonFlushTimer = null;
    cancelTimer(this._nodeUOReplicationTimer);
    this._nodeUOReplicationTimer = null;
    this._nodeUOReplicationPending?.clear?.();
    this.nodeUOJsonStats.dropped += this._nodeUOJsonDeferred.size;
    this._nodeUOJsonDeferred.clear();
    this.nodeUOJsonStats.dropped += this._nodeUOJsonReliableQueue
      .slice(this._nodeUOJsonReliableHead)
      .reduce((count, row) => count + row.count, 0);
    this._nodeUOJsonReliableQueue.length = 0;
    this._nodeUOJsonReliableHead = 0;
    this._nodeUOJsonReliableBytes = 0;
    this._nodeUOPendingAcks?.clear?.();
    this._nodeUOIdempotency?.clear?.();
    this._nodeUOInFlight?.clear?.();
    this._nodeUOFeatureRevisions?.clear?.();
    this._nodeUOSubscriptions?.clear?.();
    this._nodeUOWorldKnown?.clear?.();
    this._nodeUOChannelAcks?.clear?.();
    this._nodeUOSequences?.clear?.();
    this._nodeUOCompatibilityNotices?.clear?.();
    this.backpressureStats.dropped += this._deferredCosmetic.size;
    this._deferredCosmetic.clear();
    this._lastEntityDelta.clear();
    this._closed = true;
    diagnostics.connectionClosed(this, 'socket closed');
    if (this.mobile) {
      const mob = this.mobile;
      // If we disconnect with an item on the cursor, the item is in limbo:
      // pickup set parent=self mob and (for worn items) layer=0, so neither
      // equipmentFor() nor any container query would find it on next login.
      // Spit it out at the mobile's feet so the world stays consistent.
      // (Backpack lifted off the paperdoll then logout was the trigger for
      // "po zalogowaniu plecaczek znikl z paperdoll".)
      if (this.heldItem) {
        const it = this.heldItem;
        it.parent = null;
        it.x = mob.x; it.y = mob.y; it.z = mob.z;
        it.map = mob.map;
        it.gridX = 0; it.gridY = 0; it.gridLocation = 0;
        it.layer = 0;
        this.heldItem = null;
        const msg = worldItemSA({
          serial: it.serial, itemId: it.itemId, amount: it.amount,
          x: it.x, y: it.y, z: it.z, hue: it.hue,
          flags: (it.movable ?? true) ? 0x20 : 0x00,
        });
        // BUGFIX #65 (PHASE CW): visibility-gate. A logout on Felucca
        // doesn't need to ping every player in Trammel about the
        // backpack item drop.
        for (const other of nearbyClients(this.ctx.world, it, mob)) {
          other.client.send(msg);
        }
      }
      mob.client = null;
      this.ctx.world?.markMobileOffline?.(mob);
      // Auto-stable any unbonded pets following the disconnecting
      // master so they don't loiter as ghost followers (ServUO
      // releases unbonded pets on logout — we stable them so the
      // returning player can re-collect them). Bonded pets stamp
      // `_masterOfflineSince`; the AI tick uses that to "go home" /
      // despawn after 5 minutes of master absence.
      try {
        const stableModule = this.ctx?.systems?.petStable
                          ?? this.ctx?.handlers?.petStable;
        const stable = stableModule?.stable ?? stableModule;
        const now = Date.now();
        const petSerials = this.ctx.world._pets;
        const candidates = petSerials?.size
          ? (function* (world, serials) {
              for (const serial of serials) {
                const candidate = world.mobiles.get(serial);
                if (candidate) yield candidate;
              }
            })(this.ctx.world, petSerials)
          : this.ctx.world.mobiles.values();
        for (const candidate of candidates) {
          if (candidate === mob) continue;
          if (candidate.controlMaster !== mob.serial) continue;
          if (candidate.bonded) {
            candidate._masterOfflineSince = now;
            continue;
          }
          if (stable?.deposit) {
            const r = stable.deposit(null, mob, candidate);
            if (r?.ok) {
              // Hide the now-stabled pet from nearby clients.
              for (const other of nearbyClients(this.ctx.world, candidate, candidate)) {
                other.client.sendRemove?.(candidate.serial);
              }
              // Remove from the world map so it doesn't tick AI.
              this.ctx.world.destroyMobile?.(candidate.serial);
            }
          }
        }
      } catch (e) {
        console.warn('[net] auto-stable on logout threw:', e?.message);
      }
      // Tell nearby clients to drop this mobile from their world view.
      // BUGFIX #65: visibility-gate.
      for (const other of nearbyClients(this.ctx.world, mob, mob)) {
        other.client.sendRemove(mob.serial);
      }
      // Keep `mob` in `world.mobiles` so the next login on the same account
      // can rebind to it instead of spawning a duplicate. Removal would
      // recreate the "two admins, the old one stays standing" bug — the
      // server's account → mobile binding (set by `bringIntoWorld`) is the
      // only thing that lets a returning player reuse their character.
    }
    // Drop any in-flight interaction state so it can't leak or be replayed
    // against a reconnecting session. Without this, targetCallbacks /
    // activeGumps / activePrompts would accumulate on long-running shards
    // and, worse, a reconnecting player could inherit a dangling callback
    // from the previous login.
    for (const entry of this.targetCallbacks?.values?.() ?? []) {
      cancelTimer(entry?.timer);
    }
    this.targetCallbacks?.clear?.();
    cancelTimer(this._nodeUOSessionTimer);
    this._nodeUOSessionTimer = null;
    this.activeGumps?.clear?.();
    cancelTimer(this._gumpExpiryTimer);
    this._gumpExpiryTimer = null;
    this.activePrompts?.clear?.();
    this.openContainers?.clear?.();
    if (this.mobile) chatChannels.leaveAll(this.mobile);
    // Cancel any in-flight secure-trade session this NetState is part of.
    // Without this the partner's side stays open referencing a dead
    // NetState, items A reparented to a virtual container with
    // `map=0,x=0,y=0` linger past restart and the persistence orphan
    // sweep dumps them at facet 0 (0,0). `trade.cancel()` returns each
    // side's items to its mobile's inventory.
    try {
      const tradeApi = this.ctx?.handlers?.trade;
      if (tradeApi?.cancel) {
        const seen = new Set();
        for (const session of tradeApi._byContainer?.values?.() ?? []) {
          if (seen.has(session)) continue;
          seen.add(session);
          if (session.a === this || session.b === this) {
            try { tradeApi.cancel(session); }
            catch (e) { console.error('[net] trade cancel on disconnect threw:', e); }
          }
        }
      }
    } catch { /* trade module not wired */ }
    console.log(`[net#${this.id}] disconnected (stage=${this.stage}, account=${this.accountName})`);
  }
}
