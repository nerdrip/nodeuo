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
        this._dropBucketIfEmpty(old, ob);
      }
    }
    const b = this._bucket(mob.map | 0, sx, sy, true);
    b.mobiles.add(mob.serial);
    this._mobAt.set(mob.serial, k);
  }

  moveMobile(mob) { this.addMobile(mob); }

  removeMobile(serial) {
    const k = this._mobAt.get(serial);
    if (k === undefined) return;
    const b = this._buckets.get(k);
    if (b) {
      b.mobiles.delete(serial);
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
    const old = this._itAt.get(item.serial);
    if (old === k) return;
    if (old !== undefined) {
      const ob = this._buckets.get(old);
      if (ob) {
        ob.items.delete(item.serial);
        this._dropBucketIfEmpty(old, ob);
      }
    }
    const b = this._bucket(item.map | 0, sx, sy, true);
    b.items.add(item.serial);
    this._itAt.set(item.serial, k);
  }

  moveItem(item) { this.addItem(item); }

  removeItem(serial) {
    const k = this._itAt.get(serial);
    if (k === undefined) return;
    const b = this._buckets.get(k);
    if (b) {
      b.items.delete(serial);
      this._dropBucketIfEmpty(k, b);
    }
    this._itAt.delete(serial);
  }

  /** Drop everything — used by world reset / save reload. */
  clear() {
    this._buckets.clear();
    this._mobAt.clear();
    this._itAt.clear();
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
    for (const k of this._sectorKeysInRange(map, x, y, range)) {
      const b = this._buckets.get(k);
      if (!b) continue;
      for (const s of b.mobiles) yield s;
    }
  }

  /** Yield every grounded-item serial whose home sector overlaps. */
  *itemSerialsNear(map, x, y, range) {
    for (const k of this._sectorKeysInRange(map, x, y, range)) {
      const b = this._buckets.get(k);
      if (!b) continue;
      for (const s of b.items) yield s;
    }
  }

  /** Single-tile lookup for runtimeSolidAt-style hot paths. */
  *itemSerialsAt(map, x, y) {
    const sx = x >> SECTOR_BITS;
    const sy = y >> SECTOR_BITS;
    const b = this._buckets.get(key(map | 0, sx, sy));
    if (!b) return;
    for (const s of b.items) yield s;
  }

  /** Diagnostic — for tests / admin. */
  stats() {
    let nb = 0, nm = 0, ni = 0;
    for (const b of this._buckets.values()) {
      nb++; nm += b.mobiles.size; ni += b.items.size;
    }
    return { buckets: nb, mobiles: nm, items: ni, sectorSize: SECTOR_SIZE };
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
