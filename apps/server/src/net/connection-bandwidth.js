import { NodeUODelivery, NodeUOPriority } from '@uo/nodeuo-protocol';

const CLASS_WEIGHT = Object.freeze({ critical: 8, interactive: 4, state: 2, cosmetic: 1 });

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

export function nodeUOTrafficClass(message = {}) {
  if (message.priority === NodeUOPriority.Critical) return 'critical';
  if (message.priority === NodeUOPriority.High) return 'interactive';
  if (message.priority === NodeUOPriority.Background
      || message.delivery === NodeUODelivery.LossTolerant) return 'cosmetic';
  return 'state';
}

/** Allocation-free token bucket consulted only at transport writes. Reliable
 * ordered traffic may borrow a bounded reserve; replaceable/background data
 * is deferred or dropped instead of growing a queue. */
export class ConnectionBandwidthBudget {
  constructor({ bytesPerSecond = 512 * 1024, burstBytes, criticalReserveBytes = 64 * 1024 } = {}) {
    this.bytesPerSecond = finite(bytesPerSecond, 512 * 1024, 64 * 1024, 16 * 1024 * 1024);
    this.burstBytes = finite(burstBytes, this.bytesPerSecond * 2,
      this.bytesPerSecond, 32 * 1024 * 1024);
    this.criticalReserveBytes = finite(criticalReserveBytes, 64 * 1024, 4096, this.burstBytes);
    this.tokens = this.burstBytes;
    this.updatedAt = performance.now();
    this.stats = {
      admittedBytes: 0, borrowedBytes: 0, deferredBytes: 0, droppedBytes: 0,
      decisions: 0, byClass: { critical: 0, interactive: 0, state: 0, cosmetic: 0 },
    };
  }

  configure(options = {}) {
    this.bytesPerSecond = finite(options.bytesPerSecond, this.bytesPerSecond, 64 * 1024, 16 * 1024 * 1024);
    this.burstBytes = finite(options.burstBytes, this.bytesPerSecond * 2,
      this.bytesPerSecond, 32 * 1024 * 1024);
    this.criticalReserveBytes = finite(options.criticalReserveBytes, this.criticalReserveBytes,
      4096, this.burstBytes);
    this.tokens = Math.min(this.tokens, this.burstBytes);
    return this.snapshot();
  }

  _refill(now) {
    const elapsed = Math.max(0, Math.min(10_000, now - this.updatedAt));
    this.updatedAt = now;
    this.tokens = Math.min(this.burstBytes, this.tokens + elapsed * this.bytesPerSecond / 1000);
  }

  admit(bytesLike, { trafficClass = 'state', delivery = NodeUODelivery.Reliable } = {}, now = performance.now()) {
    const bytes = Math.max(0, Number(bytesLike) | 0);
    const kind = CLASS_WEIGHT[trafficClass] ? trafficClass : 'state';
    this._refill(now);
    this.stats.decisions++;
    this.stats.byClass[kind]++;
    if (bytes <= this.tokens) {
      this.tokens -= bytes;
      this.stats.admittedBytes += bytes;
      return 'allow';
    }
    if (kind === 'critical') {
      const borrowed = Math.max(0, bytes - Math.max(0, this.tokens));
      this.tokens = Math.max(-this.criticalReserveBytes, this.tokens - bytes);
      this.stats.admittedBytes += bytes;
      this.stats.borrowedBytes += borrowed;
      return 'allow';
    }
    if (delivery === NodeUODelivery.Reliable) {
      // A frame is atomic. If an individual validated frame is larger than
      // the configured burst, admit it only from a completely refilled
      // bucket; otherwise it could sit at the FIFO head forever.
      const oversized = bytes > this.burstBytes + this.criticalReserveBytes;
      if ((oversized && this.tokens >= this.burstBytes)
          || (!oversized && bytes <= this.tokens + this.criticalReserveBytes)) {
        const borrowed = Math.min(this.criticalReserveBytes,
          Math.max(0, bytes - Math.max(0, this.tokens)));
        this.tokens = Math.max(-this.criticalReserveBytes, this.tokens - bytes);
        this.stats.admittedBytes += bytes;
        this.stats.borrowedBytes += borrowed;
        return 'allow';
      }
      this.stats.deferredBytes += bytes;
      return 'defer';
    }
    if (delivery === NodeUODelivery.Latest && kind !== 'cosmetic') {
      this.stats.deferredBytes += bytes;
      return 'defer';
    }
    this.stats.droppedBytes += bytes;
    return 'drop';
  }

  pressure() {
    if (this.tokens < 0) return 'critical';
    const ratio = this.tokens / Math.max(1, this.burstBytes);
    return ratio < 0.1 ? 'high' : ratio < 0.35 ? 'moderate' : 'normal';
  }

  snapshot() {
    this._refill(performance.now());
    return {
      bytesPerSecond: this.bytesPerSecond,
      burstBytes: this.burstBytes,
      criticalReserveBytes: this.criticalReserveBytes,
      availableBytes: Math.trunc(this.tokens),
      pressure: this.pressure(),
      ...this.stats,
      byClass: { ...this.stats.byClass },
    };
  }
}
