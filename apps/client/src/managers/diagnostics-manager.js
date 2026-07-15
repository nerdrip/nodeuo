import { bus } from '../core/event-bus.js';
import { assets } from '../assets/asset-manager.js';
import { clientPerfStats } from '../core/game-controller.js';
import { buildClientQualityReport, clientRuntimeProfile } from '../shared/runtime-governor.js';

const PRIVATE_OPCODES = new Set([0x80, 0x91, 0xCF, 0xF8]);

class DiagnosticsManager {
  constructor() {
    this.frameHistory = new Float32Array(600);
    this.frameHead = 0;
    this.frameCount = 0;
    this.packetRecording = false;
    this.packetLimitBytes = 2 * 1024 * 1024;
    this.packetBytes = 0;
    this.packets = [];
    this.events = [];
    this.unhandledRejections = 0;
    this._lastFrameAt = 0;
    bus.on('frame:tick', (now) => this._frame(now));
    bus.on('net:packet-meta', (event) => this._packet(event));
    bus.on('net:session-reset', ({ epoch }) => this.note('session-reset', { epoch }));
    bus.on('facet:changed', (event) => this.note('facet-changed', event));
    if (typeof window !== 'undefined') {
      this._onUnhandledRejection = (event) => {
        this.unhandledRejections++;
        this.note('unhandled-rejection', { reason: String(event?.reason?.message ?? event?.reason ?? 'unknown') });
      };
      window.addEventListener('unhandledrejection', this._onUnhandledRejection);
    }
  }

  _frame(now) {
    const timestamp = Number(now) || performance.now();
    const frameMs = this._lastFrameAt ? Math.max(0, timestamp - this._lastFrameAt) : 0;
    this._lastFrameAt = timestamp;
    this.frameHistory[this.frameHead] = frameMs;
    this.frameHead = (this.frameHead + 1) % this.frameHistory.length;
    this.frameCount = Math.min(this.frameHistory.length, this.frameCount + 1);
  }

  note(type, detail = {}) {
    this.events.push({ at: Date.now(), type: String(type), detail: this._safe(detail) });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  startPacketRecording() {
    this.packetRecording = true;
    this.packetBytes = 0;
    this.packets.length = 0;
    return true;
  }
  stopPacketRecording() { this.packetRecording = false; return this.packetSnapshot(); }

  _packet({ direction, bytes } = {}) {
    if (!this.packetRecording || !(bytes instanceof Uint8Array) || bytes.length === 0) return;
    const privatePayload = PRIVATE_OPCODES.has(bytes[0]);
    const body = privatePayload ? new Uint8Array([bytes[0], bytes.length >>> 8, bytes.length & 0xff]) : bytes.slice();
    const row = { at: performance.now(), direction: direction === 'tx' ? 'tx' : 'rx', redacted: privatePayload, bytes: body };
    this.packets.push(row);
    this.packetBytes += body.byteLength;
    while (this.packetBytes > this.packetLimitBytes && this.packets.length > 1) {
      this.packetBytes -= this.packets.shift().bytes.byteLength;
    }
  }

  packetSnapshot() {
    return this.packets.map((row) => ({
      at: row.at, direction: row.direction, redacted: row.redacted,
      hex: [...row.bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
    }));
  }

  frameSnapshot() {
    const out = [];
    for (let i = 0; i < this.frameCount; i++) {
      const index = (this.frameHead - this.frameCount + i + this.frameHistory.length) % this.frameHistory.length;
      out.push(Number(this.frameHistory[index].toFixed(3)));
    }
    return out;
  }

  /** Replay the captured order deterministically. Delays are provided as
   * metadata instead of wall-clock timers so tests and bug repros produce
   * the exact same sequence on every machine. */
  replayRecording(dispatch, { direction = 'rx' } = {}) {
    if (typeof dispatch !== 'function') throw new TypeError('diagnostic replay requires a dispatcher');
    const rows = this.packetSnapshot().filter((row) => direction === 'all' || row.direction === direction);
    const start = rows[0]?.at ?? 0;
    let count = 0;
    for (const row of rows) {
      const bytes = Uint8Array.from((row.hex.match(/[0-9a-f]{2}/gi) ?? []).map((hex) => parseInt(hex, 16)));
      dispatch(bytes, { index: count, offsetMs: Number((row.at - start).toFixed(3)), direction: row.direction, redacted: row.redacted });
      count++;
    }
    this.note('packet-replay', { count, direction });
    return count;
  }

  qualityGate() {
    return { ok: this.unhandledRejections === 0, unhandledRejections: this.unhandledRejections };
  }

  exportBundle(scene = globalThis.__uo?.gc?.scene) {
    return {
      version: 2,
      generatedAt: new Date().toISOString(),
      userAgent: String(globalThis.navigator?.userAgent ?? '').slice(0, 240),
      quality: buildClientQualityReport({ profile: clientRuntimeProfile, assets, scene }),
      performance: { ...clientPerfStats, longTaskHistory: [...(clientPerfStats.longTaskHistory ?? [])] },
      frames: this.frameSnapshot(),
      packets: this.packetSnapshot(),
      events: this.events.map((event) => ({ ...event })),
      qualityGate: this.qualityGate(),
    };
  }

  _safe(value) {
    try {
      return JSON.parse(JSON.stringify(value, (key, entry) =>
        /password|secret|token|auth|account/i.test(key) ? '[redacted]' : entry));
    } catch { return {}; }
  }
}

export const diagnosticsManager = new DiagnosticsManager();
