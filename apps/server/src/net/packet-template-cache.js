/** Bounded cache of immutable, already-encoded packets shared by viewers.
 * UO packet bytes do not carry connection state, so common item/remove/vital
 * snapshots can be built once and fanned out without per-client allocation. */
export class PacketTemplateCache {
  constructor(maxEntries = 32_768) {
    this.maxEntries = Math.max(256, maxEntries | 0);
    this.entries = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  get(key, build) {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.stats.hits++;
      return existing;
    }
    const packet = build();
    this.entries.set(key, packet);
    this.stats.misses++;
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
      this.stats.evictions++;
    }
    return packet;
  }

  invalidatePrefix(prefix) {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (!String(key).startsWith(prefix)) continue;
      this.entries.delete(key); removed++;
    }
    return removed;
  }

  snapshot() { return { ...this.stats, size: this.entries.size, maxEntries: this.maxEntries }; }
}

export const sharedPacketTemplates = new PacketTemplateCache();
