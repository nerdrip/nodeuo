import { NodeUODelivery } from '@uo/nodeuo-protocol';

const CLASS_WEIGHT = Object.freeze({ critical: 4, interactive: 2, state: 1, assets: 0.75, background: 0.5 });

/** Shared token bucket plus active-peer fair shares for NodeUO traffic only. */
export class GlobalTrafficGovernor {
  constructor({ bytesPerSecond = 16 * 1024 * 1024, burstSeconds = 2,
    minimumPeerBytesPerSecond = 32 * 1024 } = {}) {
    this.peers = new Map();
    this.lastPrune = 0;
    this.stats = { allowed: 0, deferred: 0, dropped: 0, bytes: 0 };
    this.configure({ bytesPerSecond, burstSeconds, minimumPeerBytesPerSecond });
    this.tokens = this.capacity;
    this.criticalTokens = this.criticalCapacity;
    this.refilledAt = performance.now();
  }

  configure(input = {}) {
    this.rate = Math.max(64 * 1024, Math.min(1024 * 1024 * 1024,
      Number(input.bytesPerSecond) || this.rate || 16 * 1024 * 1024));
    this.burstSeconds = Math.max(1, Math.min(10, Number(input.burstSeconds) || this.burstSeconds || 2));
    this.minimumPeerRate = Math.max(4096, Math.min(4 * 1024 * 1024,
      Number(input.minimumPeerBytesPerSecond) || this.minimumPeerRate || 32 * 1024));
    this.capacity = this.rate * this.burstSeconds;
    this.criticalCapacity = Math.max(64 * 1024, this.capacity * 0.1);
    this.tokens = Math.min(this.tokens ?? this.capacity, this.capacity);
    this.criticalTokens = Math.min(this.criticalTokens ?? this.criticalCapacity, this.criticalCapacity);
    return this.snapshot();
  }

  _refill(now) {
    const elapsed = Math.max(0, now - this.refilledAt) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
      this.criticalTokens = Math.min(this.criticalCapacity, this.criticalTokens + elapsed * this.rate * 0.1);
      this.refilledAt = now;
    }
    if (now - this.lastPrune > 5000) {
      this.lastPrune = now;
      for (const [id, peer] of this.peers) if (now - peer.seenAt > 10_000) this.peers.delete(id);
    }
  }

  admit(peerId, bytes, { trafficClass = 'state', delivery = NodeUODelivery.Reliable } = {}) {
    const now = performance.now();
    this._refill(now);
    const size = Math.max(0, Number(bytes) || 0);
    const id = String(peerId);
    let peer = this.peers.get(id);
    const active = Math.max(1, this.peers.size + (peer ? 0 : 1));
    const fairRate = Math.max(this.minimumPeerRate, this.rate / active);
    if (!peer) this.peers.set(id, peer = { tokens: fairRate, refilledAt: now, seenAt: now, allowed: 0, deferred: 0, dropped: 0 });
    const elapsed = Math.max(0, now - peer.refilledAt) / 1000;
    peer.tokens = Math.min(fairRate * this.burstSeconds, peer.tokens + elapsed * fairRate);
    peer.refilledAt = now;
    peer.seenAt = now;
    const weight = CLASS_WEIGHT[trafficClass] ?? 1;
    const charged = size / weight;
    const critical = trafficClass === 'critical';
    const globalAvailable = this.tokens >= size || (critical && this.criticalTokens >= size);
    const peerAvailable = critical || peer.tokens >= charged;
    if (globalAvailable && peerAvailable) {
      if (this.tokens >= size) this.tokens -= size;
      else this.criticalTokens -= size;
      if (!critical) peer.tokens -= charged;
      peer.allowed++; this.stats.allowed++; this.stats.bytes += size;
      return 'allow';
    }
    const drop = delivery === NodeUODelivery.LossTolerant;
    if (drop) { peer.dropped++; this.stats.dropped++; return 'drop'; }
    peer.deferred++; this.stats.deferred++;
    return 'defer';
  }

  snapshot() {
    return { bytesPerSecond: this.rate, burstSeconds: this.burstSeconds,
      minimumPeerBytesPerSecond: this.minimumPeerRate, capacity: this.capacity,
      available: Math.max(0, Math.round(this.tokens ?? 0)), activePeers: this.peers.size,
      stats: { ...this.stats } };
  }
}
