const SENSITIVE_OPCODES = new Set([0x80, 0x91, 0xcf]);

function packetFingerprint(bytes) {
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index++) {
    hash ^= bytes[index]; hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class PacketReplayRecorder {
  constructor({ capacity = 20_000, enabled = true, capturePayloads = false, maxPayloadBytes = 16_384 } = {}) {
    this.capacity = Math.max(128, capacity | 0);
    this.capturePayloads = capturePayloads === true;
    this.enabled = enabled === true;
    this.maxPayloadBytes = Math.max(64, maxPayloadBytes | 0);
    this._entries = new Array(this.capacity);
    this._head = 0;
    this._count = 0;
    this._startedAt = performance.now();
    this.stats = { recorded: 0, overwritten: 0, redacted: 0, truncated: 0, replayed: 0 };
  }

  configure({ enabled, capturePayloads } = {}) {
    if (enabled != null) this.enabled = enabled === true;
    if (capturePayloads != null) this.capturePayloads = capturePayloads === true;
    return this.snapshot(false);
  }

  record(direction, packet, session = null) {
    if (!this.enabled) return null;
    const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet ?? 0);
    if (!bytes.length) return null;
    const opcode = bytes[0] & 0xff;
    const sensitive = SENSITIVE_OPCODES.has(opcode);
    const entry = {
      sequence: this.stats.recorded + 1,
      offsetMs: Number((performance.now() - this._startedAt).toFixed(3)),
      direction: direction === 'tx' ? 'tx' : 'rx', opcode,
      bytes: bytes.length, sessionId: session?.id == null ? null : String(session.id),
      stage: session?.stage == null ? null : String(session.stage),
      hash: packetFingerprint(bytes),
    };
    if (sensitive) this.stats.redacted++;
    else if (this.capturePayloads) {
      const payload = bytes.subarray(0, this.maxPayloadBytes);
      entry.payload = Buffer.from(payload).toString('base64');
      if (payload.length !== bytes.length) { entry.truncated = true; this.stats.truncated++; }
    }
    if (this._count === this.capacity) this.stats.overwritten++;
    this._entries[this._head] = entry;
    this._head = (this._head + 1) % this.capacity;
    this._count = Math.min(this.capacity, this._count + 1);
    this.stats.recorded++;
    return entry;
  }

  entries(limit = this.capacity) {
    const count = Math.min(this._count, Math.max(0, limit | 0));
    const out = new Array(count);
    const first = (this._head - count + this.capacity) % this.capacity;
    for (let index = 0; index < count; index++) out[index] = this._entries[(first + index) % this.capacity];
    return out;
  }

  exportTrace(limit = this.capacity) {
    return { version: 1, generatedAt: new Date().toISOString(), entries: this.entries(limit) };
  }

  async replay(trace, dispatch, { direction = 'rx', timed = false, speed = 1 } = {}) {
    if (typeof dispatch !== 'function') throw new TypeError('replay dispatch function required');
    const rows = (trace?.entries ?? trace ?? []).filter((entry) => entry?.direction === direction && entry.payload);
    let previousOffset = rows[0]?.offsetMs ?? 0;
    for (const entry of rows) {
      if (timed) {
        const wait = Math.max(0, (Number(entry.offsetMs) - previousOffset) / Math.max(.1, Number(speed) || 1));
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 5000)));
      }
      previousOffset = Number(entry.offsetMs) || previousOffset;
      const payload = Buffer.from(entry.payload, 'base64');
      await dispatch(payload, entry);
      this.stats.replayed++;
    }
    return { replayed: rows.length };
  }

  clear() {
    this._entries.fill(undefined); this._head = 0; this._count = 0; this._startedAt = performance.now();
  }

  snapshot(includeEntries = true, limit = 256) {
    return {
      ...this.stats, capacity: this.capacity, entriesCount: this._count,
      enabled: this.enabled, capturePayloads: this.capturePayloads,
      entries: includeEntries ? this.entries(limit) : undefined,
    };
  }
}

export const trafficReplay = new PacketReplayRecorder({
  capacity: Number(process.env.UO_REPLAY_CAPACITY ?? 20_000),
  enabled: process.env.UO_REPLAY_ENABLED === '1',
  capturePayloads: process.env.UO_REPLAY_PAYLOADS === '1',
});
