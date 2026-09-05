// NetworkStatsGump — diagnostic overlay showing live socket counters.
// Mirrors ClassicUO `Game/UI/Gumps/NetworkStatsGump.cs` (in our case
// updated once per second from the same `net.stats` object the socket
// hot-paths increment).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
import { clientPerfStats } from '../../core/game-controller.js';
import { assets } from '../../assets/asset-manager.js';
import { movementStats } from '../../managers/walker.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';
import { lightPoints } from '../../renderer/light-points.js';
import { requestNodeUOSpectatorReplay } from '../../net/nodeuo-services.js';

function fmtKB(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function topOpcodes(table, limit = 3) {
  const top = [];
  for (const k in (table ?? {})) {
    const n = table[k] | 0;
    if (n <= 0) continue;
    let i = 0;
    while (i < top.length && n <= top[i].n) i++;
    if (i >= limit) continue;
    top.splice(i, 0, { op: parseInt(k, 10), n });
    if (top.length > limit) top.length = limit;
  }
  return top;
}

function fmtOpcodeTop(prefix, entries) {
  if (!entries.length) return `${prefix} -`;
  let out = prefix;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    out += `${i ? '  ' : ' '}0x${e.op.toString(16).padStart(2, '0')}=${e.n}`;
  }
  return out;
}

export class NetworkStatsGump extends WindowGump {
  constructor() {
    super({ title: 'Network', width: 340, height: 370, x: 160, y: 80 });

    this._lines = [];
    this._lineByKey = new Map();
    const addLine = (key, y, hue = 0xfff0c0) => {
      const lbl = new Label('--', { fontSize: 11, hue });
      lbl.setPosition(12, y);
      this.add(lbl);
      this._lines.push({ key, lbl });
      this._lineByKey.set(key, lbl);
    };
    addLine('state',   28, 0x9fdcff);
    addLine('rxBytes', 50, 0xb8d7ff);
    addLine('rxPackets', 68, 0xb8d7ff);
    addLine('rxDecoded', 86, 0xb8d7ff);
    addLine('txBytes', 108, 0xffd98a);
    addLine('txPackets', 126, 0xffd98a);
    addLine('lastIO',  148, 0xfff0c0);
    addLine('frame',   166, 0xc6f7a1);
    addLine('update',  184, 0xc6f7a1);
    addLine('assets',  202, 0xd5c4ff);
    addLine('light',   220, 0xffc47d);
    addLine('move',    238, 0x9fdcff);
    addLine('ui',      256, 0xfff0c0);
    addLine('nodeuo',  274, 0xd5c4ff);

    // Per-opcode toggle button — flips the net-client tracker on/off.
    // When ON, refresh emits a top-5 RX/TX opcode tail at the bottom.
    const toggle = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 100, height: 18, label: 'Per-opcode',
      action: ButtonAction.None,
    });
    toggle.setPosition(224, 28);
    toggle.onClick = () => {
      net.trackOpcodes = !net.trackOpcodes;
      if (!net.trackOpcodes) {
        net.stats.perOpcodeRx = Object.create(null);
        net.stats.perOpcodeTx = Object.create(null);
      }
      this._refresh();
    };
    this.add(toggle);

    const trace = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 100, height: 18, label: 'Trace JSON',
      action: ButtonAction.None,
    });
    trace.setPosition(224, 50);
    trace.onClick = () => this._exportMovementTrace();
    this.add(trace);

    const replay = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 100, height: 18, label: 'Replay JSON', action: ButtonAction.None,
    });
    replay.setPosition(224, 72);
    replay.onClick = () => this._exportReplay();
    this.add(replay);

    // Extra label for the per-opcode tail (4 rows max).
    this._opcodeLabels = [];
    for (let i = 0; i < 4; i++) {
      const lbl = new Label('', { fontSize: 10, hue: 0xc0b890 });
      lbl.setPosition(12, 296 + i * 12);
      this.add(lbl);
      this._opcodeLabels.push(lbl);
    }

    this._lastRxBytes = net.stats.bytesReceived | 0;
    this._lastTxBytes = net.stats.bytesSent | 0;
    this._lastRefreshAt = 0;
    this._unsubFrame = bus.on('frame:tick', (now) => {
      if (now - this._lastRefreshAt >= 1000) this._refresh(now);
    });
    this._refresh(performance.now());
  }

  get type() { return 'network-stats'; }

  dispose() {
    this._unsubFrame?.();
    this._unsubFrame = null;
    super.dispose?.();
  }

  destroy() {
    this._unsubFrame?.();
    this._unsubFrame = null;
    super.destroy?.();
  }

  _refresh(now = performance.now()) {
    this._lastRefreshAt = now;
    const s = net.stats;
    const dRx = s.bytesReceived - this._lastRxBytes;
    const dTx = s.bytesSent - this._lastTxBytes;
    this._lastRxBytes = s.bytesReceived;
    this._lastTxBytes = s.bytesSent;
    const ratio = s.bytesReceived > 0
      ? (s.bytesDecoded / s.bytesReceived).toFixed(2) : '-';
    const lastIo = s.lastRecvAt ? `${((now - s.lastRecvAt) | 0)} ms ago` : 'never';
    const set = (k, v) => {
      this._lineByKey.get(k)?.setText?.(v);
    };
    set('state', `state: ${net.state || '-'}`);
    set('rxBytes', `rx: ${fmtKB(s.bytesReceived)}  (+${fmtKB(dRx)}/s)`);
    set('rxPackets', `rx pkt: ${s.packetsReceived}`);
    set('rxDecoded', `decoded ratio: ${ratio}x`);
    set('txBytes', `tx: ${fmtKB(s.bytesSent)}  (+${fmtKB(dTx)}/s)`);
    set('txPackets', `tx pkt: ${s.packetsSent}`);
    set('lastIO', `last rx: ${lastIo}`);
    set('frame', `frame: ${clientPerfStats.frameMs.toFixed(1)}ms p95 ${clientPerfStats.frameP95Ms.toFixed(1)} q=${clientPerfStats.qualityLevel} lag ${clientPerfStats.eventLoopLagMs.toFixed(1)} LT ${clientPerfStats.longTaskCount}/${clientPerfStats.maxLongTaskMs.toFixed(0)}`);
    set('update', `upd/draw/tick: ${clientPerfStats.updateMs.toFixed(1)} / ${clientPerfStats.drawMs.toFixed(1)} / ${clientPerfStats.tickMs.toFixed(1)}ms`);
    const mf = assets.mobileFrameStats;
    const hitPct = mf?.calls ? ((mf.hits * 100 / mf.calls) | 0) : 0;
    const avgSync = mf?.sampled ? (mf.totalSampleMs / mf.sampled).toFixed(3) : '0.000';
    const ap = assets.atlasPageStats;
    const missing = assets.missingAssetStats;
    set('assets', `anim: hit ${hitPct}% miss ${mf?.pageMisses ?? 0} avg ${avgSync}ms atlas ${ap.pages}/${ap.limit} ${fmtKB(ap.estimatedBytes)}/${fmtKB(ap.byteLimit)}${ap.overByteBudget ? ' !' : ''} missing ${missing.total}`);
    const lf = lightPoints.lightFrameStats;
    set('light', `light: ${lf.visible}/${lf.candidates} ${lf.lastMs.toFixed(2)}ms occ ${lf.occlusionHits}/${lf.occlusionCalls}`);
    set('move', `move: p${movementStats.pending}/${movementStats.maxPending} ack ${movementStats.lastAckLatencyMs.toFixed(0)}ms rej ${movementStats.rejects}`);
    const ui = uiManagerInstance.get?.();
    set('ui', `ui: gumps ${ui?.gumps?.length ?? 0} tick ${ui?.tickGumps?.length ?? 0}`);
    const n = net.nodeUOJsonStats;
    set('nodeuo', net.nodeUOJsonTransport
      ? `v2: ${net.nodeUOFeatures.size} feat · tx ${n.sent}/${n.framesSent}f · rx ${n.received}/${n.framesReceived}f · batch ${n.batchedMessages} · drop ${n.dropped}`
      : `protocol: standard UO${net.nodeUOTransportVersion ? ` + ${net.nodeUOTransportVersion}` : ''}`);

    // Per-opcode tail — top 4 RX + 1 row of top TX. Engine returns
    // {opcode → count}; sort descending and slice.
    if (net.trackOpcodes) {
      const rxTop = topOpcodes(s.perOpcodeRx, 3);
      const txTop = topOpcodes(s.perOpcodeTx, 3);
      this._opcodeLabels[0]?.setText?.(fmtOpcodeTop('RX top:', rxTop));
      this._opcodeLabels[1]?.setText?.(fmtOpcodeTop('TX top:', txTop));
      const totalKinds = (k) => Object.keys(k ?? {}).length;
      this._opcodeLabels[2]?.setText?.(`distinct rx-opcodes: ${totalKinds(s.perOpcodeRx)}`);
      this._opcodeLabels[3]?.setText?.(`distinct tx-opcodes: ${totalKinds(s.perOpcodeTx)}`);
    } else {
      for (const lbl of this._opcodeLabels) lbl?.setText?.('');
      this._opcodeLabels[0]?.setText?.('(per-opcode tracking off)');
    }
  }

  _exportMovementTrace() {
    const h = movementStats.history ?? [];
    const trace = [];
    const head = movementStats.historyIndex | 0;
    for (let i = 0; i < h.length; i++) {
      const entry = h[(head + i) & (h.length - 1)];
      if (entry) trace.push(entry);
    }
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      pending: movementStats.pending | 0,
      maxPending: movementStats.maxPending | 0,
      rejects: movementStats.rejects | 0,
      staleResyncs: movementStats.staleResyncs | 0,
      lastAckLatencyMs: movementStats.lastAckLatencyMs,
      avgAckLatencyMs: movementStats.avgAckLatencyMs,
      trace,
    }, null, 2);

    try {
      const writeText = globalThis.navigator?.clipboard?.writeText;
      if (typeof writeText === 'function') {
        writeText.call(globalThis.navigator.clipboard, payload).catch(() => {});
      }
    } catch { /* clipboard unavailable */ }
    bus.emit('debug:movement-trace', { payload, trace });
    bus.emit('chat:system', { text: 'Movement trace exported.' });
  }

  async _exportReplay() {
    try {
      const snapshot = await requestNodeUOSpectatorReplay(net, 512);
      const payload = JSON.stringify(snapshot, null, 2);
      await globalThis.navigator?.clipboard?.writeText?.(payload);
      bus.emit('debug:spectator-replay', { payload, snapshot });
      bus.emit('chat:system', { text: `Redacted replay exported (${snapshot?.entries?.length ?? snapshot?.records?.length ?? 0} entries).` });
    } catch (error) {
      bus.emit('chat:system', { text: `Replay unavailable: ${error?.message ?? error}` });
    }
  }
}
