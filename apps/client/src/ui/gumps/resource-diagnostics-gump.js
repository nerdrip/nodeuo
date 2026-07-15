import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { diagnosticsManager } from '../../managers/diagnostics-manager.js';
import { movementStats } from '../../managers/walker.js';
import { assets } from '../../assets/asset-manager.js';
import { landMeshPool, spritePool } from '../../renderer/sprite-pool.js';
import { clientPerfStats } from '../../core/game-controller.js';
import { bus } from '../../core/event-bus.js';

function downloadJson(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export class ResourceDiagnosticsGump extends WindowGump {
  constructor() {
    super({ title: 'Resource diagnostics', width: 520, height: 380, x: 210, y: 90 });
    this.positionKey = 'resource-diagnostics';
    this._labels = [];
    for (let i = 0; i < 9; i++) {
      const label = new Label('', { fontSize: 11, hue: i === 0 ? 0x9fdcff : 0xfff0c0 });
      label.setPosition(14, 30 + i * 20); this.add(label); this._labels.push(label);
    }
    this._graph = new Graphics();
    this._graph.position.set(14, 218); this.node.addChild(this._graph);
    const button = (label, x, fn) => {
      const control = new Button({ normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 112, height: 20, label, action: ButtonAction.None });
      control.setPosition(x, 342); control.onClick = fn; this.add(control);
    };
    button('Record packets', 14, () => diagnosticsManager.startPacketRecording());
    button('Stop', 136, () => diagnosticsManager.stopPacketRecording());
    button('Export bundle', 258, () => downloadJson(`nodeuo-diagnostics-${Date.now()}.json`, diagnosticsManager.exportBundle()));
    button('Clear missing', 380, () => assets.clearMissingAssetStats());
    this._lastRefreshAt = 0;
    this._off = bus.on('frame:tick', (now) => {
      if (now - this._lastRefreshAt > 250) this._refresh(now);
    });
    this._refresh(performance.now());
  }

  get type() { return 'resource-diagnostics'; }

  _refresh(now) {
    this._lastRefreshAt = now;
    const snapshot = assets.diagnosticsSnapshot();
    const chunks = globalThis.__uo?.gc?.scene?._tiles?.diagnosticsSnapshot?.() ?? {};
    const pool = spritePool.stats();
    const meshes = landMeshPool.stats();
    const jitter = Math.abs((movementStats.lastAckLatencyMs || 0) - (movementStats.avgAckLatencyMs || 0));
    const rows = [
      `tier ${snapshot.profile?.tier ?? '-'}  latency ${movementStats.lastAckLatencyMs.toFixed(1)} ms  jitter ${jitter.toFixed(1)} ms`,
      `atlas ${snapshot.atlas.pages}/${snapshot.atlas.limit}  ${(snapshot.atlas.estimatedBytes / 1048576).toFixed(1)} / ${(snapshot.atlas.byteLimit / 1048576).toFixed(0)} MiB`,
      `cache land ${snapshot.caches.land} static ${snapshot.caches.static} gump ${snapshot.caches.gump} anim ${snapshot.caches.mobile} tex ${snapshot.caches.texmap}`,
      `decode active ${snapshot.decodePool?.active ?? 0}/${snapshot.decodePool?.limit ?? 0} queued ${snapshot.decodePool?.queued ?? 0}`,
      `chunks ${chunks.chunks ?? 0} ready ${chunks.readyChunks ?? 0} queued ${chunks.queuedChunks ?? 0} active ${chunks.activePopulates ?? 0}`,
      `stream budget ${Number(chunks.scheduler?.budgetMs ?? 0).toFixed(2)} ms  last ${Number(chunks.scheduler?.lastMs ?? 0).toFixed(2)} ms`,
      `sprites ${pool.active}/${pool.free} reuse ${pool.reuses}  meshes ${meshes.active}/${meshes.free} reuse ${meshes.reuses}`,
      `missing ${snapshot.missing.total}  packet recording ${diagnosticsManager.packetRecording ? 'ON' : 'off'} ${(diagnosticsManager.packetBytes / 1024).toFixed(1)} KiB`,
      `long task ${clientPerfStats.lastLongTaskMs.toFixed(1)} ms (${clientPerfStats.longTaskHistory[(clientPerfStats.longTaskHead - 1 + clientPerfStats.longTaskHistory.length) % clientPerfStats.longTaskHistory.length]?.subsystem ?? '-'})  unhandled ${diagnosticsManager.unhandledRejections}`,
    ];
    rows.forEach((text, index) => this._labels[index]?.setText?.(text));
    const history = diagnosticsManager.frameSnapshot().slice(-600);
    this._graph.clear().rect(0, 0, 490, 108).fill({ color: 0x080c12, alpha: 0.84 })
      .stroke({ width: 1, color: 0x63502d, alpha: 0.8 });
    if (history.length > 1) {
      const points = [];
      for (let i = 0; i < history.length; i++) {
        points.push(i * 489 / (history.length - 1), 106 - Math.min(100, history[i]) * 1.02);
      }
      this._graph.poly(points, false).stroke({ width: 1.5, color: 0x71d6ff, alpha: 0.95 });
    }
  }

  dispose() { this._off?.(); this._off = null; super.dispose?.(); }
}
