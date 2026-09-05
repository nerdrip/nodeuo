import { stableJsonFingerprint } from '@uo/nodeuo-protocol';

const SENSITIVE_INPUTS = new Set([0x80, 0x91, 0xcf]);

function safeData(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 512);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => safeData(entry, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 128);
  const out = {};
  for (const [key, entry] of Object.entries(value).slice(0, 64)) {
    out[key] = /password|secret|token|cookie/i.test(key)
      ? '[REDACTED]' : safeData(entry, depth + 1);
  }
  return out;
}

/** Ordered simulation journal for reproducible short bug captures. It is off
 * by default, bounded in memory and redacts login material unconditionally. */
export class SimulationReplayRecorder {
  constructor({ capacity = 50_000, enabled = false, captureInputs = false } = {}) {
    this.capacity = Math.max(256, capacity | 0);
    this.enabled = enabled === true;
    this.captureInputs = captureInputs === true;
    this.entries = new Array(this.capacity);
    this.head = 0;
    this.count = 0;
    this.sequence = 0;
    this.ticks = new Map();
    this.startedAt = performance.now();
    this.stats = { recorded: 0, overwritten: 0, inputs: 0, decisions: 0, seeds: 0, checkpoints: 0 };
  }

  configure({ enabled, captureInputs } = {}) {
    if (enabled != null) this.enabled = enabled === true;
    if (captureInputs != null) this.captureInputs = captureInputs === true;
    return this.snapshot(false);
  }

  _push(entry) {
    if (!this.enabled) return null;
    const row = { sequence: ++this.sequence,
      offsetMs: Number((performance.now() - this.startedAt).toFixed(3)), ...entry };
    if (this.count === this.capacity) this.stats.overwritten++;
    this.entries[this.head] = row;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    this.stats.recorded++;
    return row;
  }

  beginTick(domain, at = Date.now()) {
    if (!this.enabled) return 0;
    const key = String(domain).slice(0, 48);
    const tick = (this.ticks.get(key) ?? 0) + 1;
    this.ticks.set(key, tick);
    this._push({ type: 'tick', domain: key, tick, at });
    return tick;
  }

  input(state, packet) {
    if (!this.enabled) return null;
    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet ?? 0);
    if (!bytes.length) return null;
    const opcode = bytes[0] & 0xff;
    const row = { type: 'input', domain: 'network', tick: this.ticks.get('world') ?? 0,
      sessionId: state?.id == null ? null : String(state.id), opcode, bytes: bytes.length };
    if (this.captureInputs && !SENSITIVE_INPUTS.has(opcode)) row.payload = Buffer.from(bytes).toString('base64');
    else row.redacted = true;
    this.stats.inputs++;
    return this._push(row);
  }

  decision(domain, actor, name, data = {}) {
    if (!this.enabled) return null;
    this.stats.decisions++;
    return this._push({ type: 'decision', domain: String(domain).slice(0, 48),
      tick: this.ticks.get(String(domain)) ?? 0, actor: Number(actor) >>> 0 || null,
      name: String(name).slice(0, 96), data: safeData(data) });
  }

  seed(domain, value) {
    if (!this.enabled) return null;
    this.stats.seeds++;
    return this._push({ type: 'seed', domain: String(domain).slice(0, 48), value: String(value).slice(0, 128) });
  }

  checkpoint(name, value) {
    if (!this.enabled) return null;
    this.stats.checkpoints++;
    return this._push({ type: 'checkpoint', name: String(name).slice(0, 96),
      fingerprint: `fnv1a64:${stableJsonFingerprint(safeData(value))}` });
  }

  rows(limit = this.capacity) {
    const count = Math.min(this.count, Math.max(0, limit | 0));
    const out = new Array(count);
    const first = (this.head - count + this.capacity) % this.capacity;
    for (let index = 0; index < count; index++) out[index] = this.entries[(first + index) % this.capacity];
    return out;
  }

  exportTrace(limit = this.capacity) {
    const entries = this.rows(limit);
    return { version: 1, kind: 'nodeuo-simulation', generatedAt: new Date().toISOString(),
      fingerprint: `fnv1a64:${stableJsonFingerprint(entries)}`, entries };
  }

  clear() {
    this.entries.fill(undefined); this.head = 0; this.count = 0; this.sequence = 0;
    this.ticks.clear(); this.startedAt = performance.now();
  }

  snapshot(includeEntries = true, limit = 256) {
    return { ...this.stats, enabled: this.enabled, captureInputs: this.captureInputs,
      capacity: this.capacity, entriesCount: this.count, ticks: Object.fromEntries(this.ticks),
      entries: includeEntries ? this.rows(limit) : undefined };
  }
}

export const simulationReplay = new SimulationReplayRecorder({
  capacity: Number(process.env.UO_SIMULATION_REPLAY_CAPACITY ?? 50_000),
  enabled: process.env.UO_SIMULATION_REPLAY === '1',
  captureInputs: process.env.UO_SIMULATION_REPLAY_INPUTS === '1',
});
