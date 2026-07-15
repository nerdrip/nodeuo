// Sector spatial index. Mirrors ServUO `Map.Sectors[,]` — the grid that
// keeps "what's near (x,y)" and "what's at (x,y)" fast as world.items
// grows past a few thousand entries.
//
// Each sector covers SECTOR_SIZE × SECTOR_SIZE tiles (default 8 × 8 to
// match ServUO `Sector.SectorSize`). Mobiles + items are bucketed by
// `(map, sx, sy)` where `sx = x >> 3, sy = y >> 3`. Visibility queries
// scan only the 3×3 neighbour grid — at update range 18, that's a worst
// case of 64×64 tiles vs the prior 7168×4096 world walk.
//
// Membership is maintained by callers via three hooks:
//   `addMobile / moveMobile / removeMobile`
//   `addItem   / moveItem   / removeItem`
//
// We don't try to be clever about diffing positions; callers update the
// index whenever they touch x/y/map. A no-op on same-sector moves is
// almost free (set lookup + early-return).
//
// This module is OPT-IN: the world keeps a Map<serial, mob/item> as the
// authoritative store. Sectors are an index built ON TOP of that store.
// Callers that haven't switched to sector queries continue to walk the
// authoritative Map without breakage.

const SECTOR_BITS = 3;            // 1 << 3 = 8
const SECTOR_SIZE = 1 << SECTOR_BITS;
const SECTOR_MASK = SECTOR_SIZE - 1;

function key(map, sx, sy) {
  // Pack into a single number — keeps the outer Map small + GC-light.
  // Map ids are 0..5; sx/sy are <= 1023 each. Use 11 bits per axis +
  // 4 for map = 26 bits, fits comfortably in a JS smi.
  return ((map & 0x0F) << 22) | ((sx & 0x7FF) << 11) | (sy & 0x7FF);
}

function tileKey(map, x, y) {
  return ((map & 0x0f) * 0x20000000) + ((y & 0x0fff) * 0x2000) + (x & 0x1fff);
}

export class SectorIndex {
  constructor() {
    /** @type {Map<number, { mobiles: Set<number>, items: Set<number> }>} */
    this._buckets = new Map();
    // Per-entity reverse index so we can de-register on move without a
    // bucket scan. Stores the LAST sector key the entity was placed in.
    /** @type {Map<number, number>} */
    this._mobAt = new Map();
    /** @type {Map<number, number>} */
    this._itAt = new Map();
    this._tileItems = new Map();
    this._itTile = new Map();
    this._revisions = new Map();
    this._globalRevision = 1;
    this._queryStats = {
      calls: 0, candidates: 0, totalMs: 0, maxMs: 0,
      mobileCalls: 0, itemCalls: 0, tileCalls: 0,
    };
  }

  _bump(k) {
    if (k === undefined) return;
    this._globalRevision = (this._globalRevision + 1) >>> 0 || 1;
    this._revisions.set(k, this._globalRevision);
  }

  _bucket(map, sx, sy, create = false) {
    const k = key(map, sx, sy);
    let b = this._buckets.get(k);
    if (!b && create) {
      b = { mobiles: new Set(), items: new Set() };
      this._buckets.set(k, b);
    }
    return b;
  }

  _dropBucketIfEmpty(k, b) {
    if (b && b.mobiles.size === 0 && b.items.size === 0) {
      this._buckets.delete(k);
    }
  }

  // ---------- Mobile membership -----------------------------------------

  addMobile(mob) {
    if (!mob) return;
    // Bug-hunt #12 B4 — reject out-of-bounds before sector-bucket math.
    // A negative x (briefly seen during dismount / boat de-board before
    // resolveStandingZ runs) would `>> 3` to -1 then mask via `& 0x7FF`
    // to 2047, bucketing the mob in a far-edge sector forever.
    const mx = mob.x | 0, my = mob.y | 0;
    if (mx < 0 || mx > 7167 || my < 0 || my > 4095) {
      this.removeMobile(mob.serial);
      return;
    }
    const sx = mx >> SECTOR_BITS;
    const sy = my >> SECTOR_BITS;
    const k = key(mob.map | 0, sx, sy);
    const old = this._mobAt.get(mob.serial);
    if (old === k) return;
    if (old !== undefined) {
      const ob = this._buckets.get(old);
      if (ob) {
        ob.mobiles.delete(mob.serial);
        this._bump(old);
        this._dropBucketIfEmpty(old, ob);
      }
    }
    const b = this._bucket(mob.map | 0, sx, sy, true);
    b.mobiles.add(mob.serial);
    this._mobAt.set(mob.serial, k);
    this._bump(k);
  }

  moveMobile(mob) { this.addMobile(mob); }

  removeMobile(serial) {
    const k = this._mobAt.get(serial);
    if (k === undefined) return;
    const b = this._buckets.get(k);
    if (b) {
      b.mobiles.delete(serial);
      this._bump(k);
      this._dropBucketIfEmpty(k, b);
    }
    this._mobAt.delete(serial);
  }

  // ---------- Item membership -------------------------------------------

  addItem(item) {
    if (!item) return;
    if (item.parent) {
      // Items in containers / on a paperdoll don't live in a tile.
      this.removeItem(item.serial);
      return;
    }
    // Bug-hunt #12 B4 — same OOB guard as addMobile.
    const ix = item.x | 0, iy = item.y | 0;
    if (ix < 0 || ix > 7167 || iy < 0 || iy > 4095) {
      this.removeItem(item.serial);
      return;
    }
    const sx = ix >> SECTOR_BITS;
    const sy = iy >> SECTOR_BITS;
    const k = key(item.map | 0, sx, sy);
    const tk = tileKey(item.map | 0, ix, iy);
    const old = this._itAt.get(item.serial);
    const oldTile = this._itTile.get(item.serial);
    if (oldTile !== tk) {
      const oldSet = this._tileItems.get(oldTile);
      oldSet?.delete(item.serial);
      if (oldSet?.size === 0) this._tileItems.delete(oldTile);
      const set = this._tileItems.get(tk) ?? new Set();
      set.add(item.serial); this._tileItems.set(tk, set); this._itTile.set(item.serial, tk);
    }
    if (old === k) return;
    if (old !== undefined) {
      const ob = this._buckets.get(old);
      if (ob) {
        ob.items.delete(item.serial);
        this._bump(old);
        this._dropBucketIfEmpty(old, ob);
      }
    }
    const b = this._bucket(item.map | 0, sx, sy, true);
    b.items.add(item.serial);
    this._itAt.set(item.serial, k);
    this._bump(k);
  }

  moveItem(item) { this.addItem(item); }

  removeItem(serial) {
    const k = this._itAt.get(serial);
    if (k === undefined) return;
    const b = this._buckets.get(k);
    if (b) {
      b.items.delete(serial);
      this._bump(k);
      this._dropBucketIfEmpty(k, b);
    }
    this._itAt.delete(serial);
    const tk = this._itTile.get(serial);
    const set = this._tileItems.get(tk);
    set?.delete(serial);
    if (set?.size === 0) this._tileItems.delete(tk);
    this._itTile.delete(serial);
  }

  /** Drop everything — used by world reset / save reload. */
  clear() {
    this._buckets.clear();
    this._mobAt.clear();
    this._itAt.clear();
    this._tileItems.clear();
    this._itTile.clear();
    this._revisions.clear();
    this._globalRevision = (this._globalRevision + 1) >>> 0 || 1;
  }

  // ---------- Queries ---------------------------------------------------

  /** Iterate sector keys covering the rectangle min..max. */
  *_sectorKeysInRange(map, x, y, range) {
    const sx0 = (x - range) >> SECTOR_BITS;
    const sy0 = (y - range) >> SECTOR_BITS;
    const sx1 = (x + range) >> SECTOR_BITS;
    const sy1 = (y + range) >> SECTOR_BITS;
    for (let sx = sx0; sx <= sx1; sx++) {
      for (let sy = sy0; sy <= sy1; sy++) {
        yield key(map | 0, sx, sy);
      }
    }
  }

  /** Yield every mobile serial whose home sector overlaps the range. */
  *mobileSerialsNear(map, x, y, range) {
    const started = performance.now();
    let candidates = 0;
    for (const k of this._sectorKeysInRange(map, x, y, range)) {
      const b = this._buckets.get(k);
      if (!b) continue;
      for (const s of b.mobiles) { candidates++; yield s; }
    }
    this._recordQuery('mobileCalls', started, candidates);
  }

  /** Yield every grounded-item serial whose home sector overlaps. */
  *itemSerialsNear(map, x, y, range) {
    const started = performance.now();
    let candidates = 0;
    for (const k of this._sectorKeysInRange(map, x, y, range)) {
      const b = this._buckets.get(k);
      if (!b) continue;
      for (const s of b.items) { candidates++; yield s; }
    }
    this._recordQuery('itemCalls', started, candidates);
  }

  /** Single-tile lookup for runtimeSolidAt-style hot paths. */
  *itemSerialsAt(map, x, y) {
    const started = performance.now();
    let candidates = 0;
    for (const serial of this._tileItems.get(tileKey(map | 0, x | 0, y | 0)) ?? []) {
      candidates++;
      yield serial;
    }
    this._recordQuery('tileCalls', started, candidates);
  }

  _recordQuery(kind, started, candidates) {
    const ms = Math.max(0, performance.now() - started);
    this._queryStats.calls++;
    this._queryStats[kind]++;
    this._queryStats.candidates += candidates;
    this._queryStats.totalMs += ms;
    this._queryStats.maxMs = Math.max(this._queryStats.maxMs, ms);
  }

  revisionForRange(map, x, y, range) {
    let revision = 0;
    for (const k of this._sectorKeysInRange(map, x, y, range)) revision = Math.max(revision, this._revisions.get(k) ?? 0);
    return revision;
  }

  get revision() { return this._globalRevision; }

  /** Diagnostic — for tests / admin. */
  stats() {
    let nb = 0, nm = 0, ni = 0;
    for (const b of this._buckets.values()) {
      nb++; nm += b.mobiles.size; ni += b.items.size;
    }
    const q = this._queryStats;
    return { buckets: nb, tileBuckets: this._tileItems.size, mobiles: nm, items: ni,
      revision: this._globalRevision, sectorSize: SECTOR_SIZE,
      queries: { ...q,
        averageMs: q.calls ? Number((q.totalMs / q.calls).toFixed(4)) : 0,
        averageCandidates: q.calls ? Number((q.candidates / q.calls).toFixed(2)) : 0,
      } };
  }

  validate(world, { repair = false } = {}) {
    const issues = [];
    for (const [serial, k] of this._mobAt) {
      if (!world?.mobiles?.has(serial) || !this._buckets.get(k)?.mobiles.has(serial)) issues.push({ kind: 'mobile', serial });
    }
    for (const [serial, k] of this._itAt) {
      const item = world?.items?.get(serial);
      if (!item || item.parent || !this._buckets.get(k)?.items.has(serial)) issues.push({ kind: 'item', serial });
    }
    // The reverse walk is intentionally confined to the background/startup
    // validator. Hot visibility/movement paths never scan the whole world.
    for (const mobile of world?.mobiles?.values?.() ?? []) {
      if (!this._mobAt.has(mobile.serial)) issues.push({ kind: 'missing-mobile', serial: mobile.serial });
    }
    for (const item of world?.items?.values?.() ?? []) {
      if (!item.parent && !this._itAt.has(item.serial)) issues.push({ kind: 'missing-item', serial: item.serial });
      if (item.parent && this._itAt.has(item.serial)) issues.push({ kind: 'parented-item', serial: item.serial });
    }
    if (repair && issues.length) this.rebuild(world);
    return { ok: issues.length === 0, issues, repaired: !!(repair && issues.length) };
  }

  rebuild(world) {
    this.clear();
    for (const mobile of world?.mobiles?.values?.() ?? []) this.addMobile(mobile);
    for (const item of world?.items?.values?.() ?? []) this.addItem(item);
    return this.stats();
  }

  /** True if the index has tracked at least one mobile. Visibility
   *  helpers use this to decide between the fast sector path and the
   *  legacy full walk — test fixtures bypass `createMobile` and stuff
   *  values into `world.mobiles` directly, leaving the index empty;
   *  detecting that lets the helper fall back gracefully. */
  mobilesIndexed() { return this._mobAt.size; }
  /** Same idea for items. */
  itemsIndexed() { return this._itAt.size; }

  /** Iterate every grounded item serial. Decay sweeper / world-wide
   *  scans use this so they only touch parent-less items (the index
   *  drops items when they get parented). On a 110k-item shard with
   *  ~5k actual ground items this turns a 110k walk into a 5k walk
   *  every minute. */
  *allItemSerials() {
    for (const serial of this._itAt.keys()) yield serial;
  }

  /** Iterate every tracked mobile serial. */
  *allMobileSerials() {
    for (const serial of this._mobAt.keys()) yield serial;
  }
}

export const sectorSize = SECTOR_SIZE;
export const SECTOR_MASK_LOW = SECTOR_MASK;
