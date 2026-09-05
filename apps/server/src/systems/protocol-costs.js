const DEFAULT_BUCKET_MS = 10_000;
const DEFAULT_HISTORY_BUCKETS = 360;

function freshRow(feature) {
  return { feature, inbound: 0, outbound: 0, bytesIn: 0, bytesOut: 0,
    handled: 0, deferred: 0, dropped: 0, rejected: 0, errors: 0,
    totalMs: 0, maxMs: 0, lastAt: 0 };
}

/** Allocation-bounded cost accounting for negotiated protocol features. */
export class ProtocolCostTracker {
  constructor({ bucketMs = DEFAULT_BUCKET_MS, historyBuckets = DEFAULT_HISTORY_BUCKETS } = {}) {
    this.bucketMs = Math.max(1000, bucketMs | 0);
    this.historyBuckets = Math.max(6, historyBuckets | 0);
    this.rows = new Map();
    this.history = [];
    this.current = this._bucket(Date.now());
  }

  _bucket(now) {
    return { at: Math.floor(now / this.bucketMs) * this.bucketMs,
      inbound: 0, outbound: 0, bytesIn: 0, bytesOut: 0, totalMs: 0,
      errors: 0, dropped: 0, deferred: 0 };
  }

  _rotate(now) {
    const at = Math.floor(now / this.bucketMs) * this.bucketMs;
    if (this.current.at === at) return;
    this.history.push(this.current);
    if (this.history.length > this.historyBuckets) {
      this.history.splice(0, this.history.length - this.historyBuckets);
    }
    this.current = this._bucket(now);
  }

  record(feature, direction, { bytes = 0, ms = 0, outcome = 'handled', now = Date.now() } = {}) {
    const id = String(feature ?? 'unknown').slice(0, 128);
    this._rotate(now);
    let row = this.rows.get(id);
    if (!row) this.rows.set(id, row = freshRow(id));
    const size = Math.max(0, Number(bytes) || 0);
    const elapsed = Math.max(0, Number(ms) || 0);
    if (direction === 'inbound') { row.inbound++; row.bytesIn += size; this.current.inbound++; this.current.bytesIn += size; }
    else { row.outbound++; row.bytesOut += size; this.current.outbound++; this.current.bytesOut += size; }
    const normalizedOutcome = outcome === 'error' ? 'errors' : outcome;
    if (Object.hasOwn(row, normalizedOutcome)) row[normalizedOutcome]++;
    else row.handled++;
    if (normalizedOutcome === 'errors') this.current.errors++;
    if (outcome === 'dropped') this.current.dropped++;
    if (outcome === 'deferred') this.current.deferred++;
    row.totalMs += elapsed;
    row.maxMs = Math.max(row.maxMs, elapsed);
    row.lastAt = now;
    this.current.totalMs += elapsed;
    return row;
  }

  snapshot({ historyLimit = 120 } = {}) {
    this._rotate(Date.now());
    const features = [...this.rows.values()].map((row) => ({
      ...row,
      avgMs: Number((row.totalMs / Math.max(1, row.inbound + row.outbound)).toFixed(4)),
      totalMs: Number(row.totalMs.toFixed(3)), maxMs: Number(row.maxMs.toFixed(3)),
    })).sort((a, b) => b.totalMs - a.totalMs || (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut));
    return {
      bucketMs: this.bucketMs,
      totals: features.reduce((out, row) => ({
        messages: out.messages + row.inbound + row.outbound,
        bytes: out.bytes + row.bytesIn + row.bytesOut,
        cpuMs: out.cpuMs + row.totalMs,
        errors: out.errors + row.errors,
        dropped: out.dropped + row.dropped,
      }), { messages: 0, bytes: 0, cpuMs: 0, errors: 0, dropped: 0 }),
      features,
      history: [...this.history, this.current].slice(-Math.max(1, Math.min(360, historyLimit | 0))),
      recommendations: features.filter((row) => row.errors >= 3 || row.maxMs >= 25 || row.dropped >= 20)
        .slice(0, 20).map((row) => ({ feature: row.feature,
          severity: row.errors >= 10 || row.maxMs >= 100 ? 'critical' : 'warning',
          reason: row.errors >= 3 ? `${row.errors} errors` : row.maxMs >= 25
            ? `max handler/send cost ${row.maxMs}ms` : `${row.dropped} dropped messages`,
          dryRun: true })),
    };
  }
}

export const protocolCosts = new ProtocolCostTracker();
