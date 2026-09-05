const DEFAULT_GLOBAL_CAPACITY = 8_192;
const DEFAULT_SECTOR_CAPACITY = 256;
const DEFAULT_MAX_SECTORS = 16_384;

class BoundedRing {
  constructor(capacity) {
    this.capacity = capacity;
    this.rows = new Array(capacity);
    this.start = 0;
    this.size = 0;
    this.droppedThrough = 0;
  }

  push(row) {
    if (this.size < this.capacity) {
      this.rows[(this.start + this.size++) % this.capacity] = row;
      return;
    }
    this.droppedThrough = this.rows[this.start]?.sequence ?? this.droppedThrough;
    this.rows[this.start] = row;
    this.start = (this.start + 1) % this.capacity;
  }

  *after(sequence) {
    for (let index = 0; index < this.size; index++) {
      const row = this.rows[(this.start + index) % this.capacity];
      if (row.sequence > sequence) yield row;
    }
  }
}

/** Bounded revision history keyed by 8x8 world sectors. Records are shared
 * between persistence, replication and progressive catch-up consumers. */
export class SectorChangeLog {
  constructor({
    globalCapacity = DEFAULT_GLOBAL_CAPACITY,
    sectorCapacity = DEFAULT_SECTOR_CAPACITY,
    maxSectors = DEFAULT_MAX_SECTORS,
  } = {}) {
    this.global = new BoundedRing(Math.max(256, globalCapacity | 0));
    this.sectorCapacity = Math.max(32, sectorCapacity | 0);
    this.maxSectors = Math.max(256, maxSectors | 0);
    this.sectors = new Map();
    this.locations = new Map();
    this.sequence = 0;
    this.evictedThrough = 0;
    this.stats = { appended: 0, coalescedQueries: 0, sectorEvictions: 0, queries: 0 };
  }

  append({ serial, mask, kind, revision, location }) {
    const id = Number(serial) >>> 0;
    if (!id) return null;
    const previousLocation = this.locations.get(id);
    const resolved = location ?? previousLocation ?? null;
    if (location) this.locations.set(id, Object.freeze({ ...location }));
    if (mask & (1 << 6)) this.locations.delete(id);
    const row = Object.freeze({
      sequence: ++this.sequence, serial: id, mask: Number(mask) >>> 0,
      kind: String(kind), revision: Number(revision) >>> 0,
      location: resolved ? Object.freeze({ ...resolved }) : null,
    });
    this.global.push(row);
    const sectorKey = resolved?.sectorKey;
    if (sectorKey != null) {
      let ring = this.sectors.get(sectorKey);
      if (!ring) {
        if (this.sectors.size >= this.maxSectors) {
          const oldestKey = this.sectors.keys().next().value;
          const oldest = this.sectors.get(oldestKey);
          this.evictedThrough = Math.max(this.evictedThrough,
            oldest?.droppedThrough ?? 0, oldest?.rows?.[oldest?.start]?.sequence ?? 0);
          this.sectors.delete(oldestKey);
          this.stats.sectorEvictions++;
        }
        ring = new BoundedRing(this.sectorCapacity);
      } else this.sectors.delete(sectorKey);
      ring.push(row);
      this.sectors.set(sectorKey, ring);
    }
    this.stats.appended++;
    return row;
  }

  changesSince(sequenceLike, { sectorKeys = null, limit = 1024 } = {}) {
    const sequence = Math.max(0, Number(sequenceLike) || 0);
    const take = Math.max(1, Math.min(8192, Number(limit) | 0 || 1024));
    const sources = Array.isArray(sectorKeys)
      ? [...new Set(sectorKeys)].map((key) => this.sectors.get(key)).filter(Boolean)
      : [this.global];
    let resetRequired = sequence > 0 && sequence < this.evictedThrough;
    const merged = new Map();
    for (const ring of sources) {
      if (sequence > 0 && sequence < ring.droppedThrough) resetRequired = true;
      for (const row of ring.after(sequence)) {
        const key = `${row.kind}:${row.serial}`;
        const prior = merged.get(key);
        if (prior) {
          merged.set(key, { ...row, mask: (prior.mask | row.mask) >>> 0 });
          this.stats.coalescedQueries++;
        } else merged.set(key, row);
      }
    }
    const changes = [...merged.values()].sort((a, b) => a.sequence - b.sequence).slice(0, take);
    this.stats.queries++;
    return Object.freeze({ cursor: this.sequence, resetRequired, changes });
  }

  snapshot() {
    return Object.freeze({ ...this.stats, sequence: this.sequence, sectors: this.sectors.size,
      trackedLocations: this.locations.size, globalCapacity: this.global.capacity,
      sectorCapacity: this.sectorCapacity, maxSectors: this.maxSectors });
  }
}
