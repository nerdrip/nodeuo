import { SectorChangeLog } from './sector-change-log.js';

export const EntityDirty = Object.freeze({
  Position: 1 << 0,
  Appearance: 1 << 1,
  Vitals: 1 << 2,
  Properties: 1 << 3,
  Parent: 1 << 4,
  Created: 1 << 5,
  Removed: 1 << 6,
  All: 0x7f,
});

/** Per-entity dirty bitsets shared by persistence and interest fan-out.
 * Multiple mutations before a consumer pass collapse into one Map entry. */
export class InterestManager {
  constructor({ maxDirty = 100_000 } = {}) {
    this.maxDirty = Math.max(1024, maxDirty | 0);
    this.dirty = new Map();
    this.revisions = new Map();
    this.listeners = new Set();
    this.changeLog = new SectorChangeLog();
    this.locationResolver = null;
    this.stats = { marked: 0, coalesced: 0, consumed: 0, dropped: 0 };
  }

  mark(serialLike, mask = EntityDirty.All, kind = 'entity') {
    const serial = Number(serialLike) >>> 0;
    if (!serial) return 0;
    const previous = this.dirty.get(serial);
    if (previous) {
      previous.mask |= mask;
      previous.kind = kind || previous.kind;
      this.stats.coalesced++;
    } else {
      if (this.dirty.size >= this.maxDirty) {
        this.dirty.delete(this.dirty.keys().next().value);
        this.stats.dropped++;
      }
      this.dirty.set(serial, { serial, mask: mask >>> 0, kind: String(kind), at: Date.now() });
    }
    const revision = ((this.revisions.get(serial) ?? 0) + 1) >>> 0 || 1;
    this.revisions.set(serial, revision);
    this.stats.marked++;
    const location = this.locationResolver?.(serial, String(kind)) ?? null;
    const change = this.changeLog.append({ serial, mask, kind, revision, location });
    for (const listener of this.listeners) {
      try { listener(serial, mask >>> 0, String(kind), revision, change); } catch { /* advisory consumer */ }
    }
    return revision;
  }

  consume(limit = 1024) {
    const rows = [];
    const take = Math.max(1, limit | 0);
    for (const [serial, row] of this.dirty) {
      rows.push(row); this.dirty.delete(serial);
      if (row.mask & EntityDirty.Removed) this.revisions.delete(serial);
      if (rows.length >= take) break;
    }
    this.stats.consumed += rows.length;
    return rows;
  }

  revision(serialLike) { return this.revisions.get(Number(serialLike) >>> 0) ?? 0; }
  forget(serialLike) { const serial = Number(serialLike) >>> 0; this.dirty.delete(serial); this.revisions.delete(serial); }
  onDirty(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  bindLocationResolver(resolver) { this.locationResolver = typeof resolver === 'function' ? resolver : null; }
  changesSince(sequence, options) { return this.changeLog.changesSince(sequence, options); }
  snapshot() { return { ...this.stats, pending: this.dirty.size, trackedRevisions: this.revisions.size,
    maxDirty: this.maxDirty, changeLog: this.changeLog.snapshot() }; }
}
