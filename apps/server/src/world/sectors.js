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

export function sectorKeyForPosition(map, x, y) {
  return key(Number(map) | 0, (Number(x) | 0) >> SECTOR_BITS, (Number(y) | 0) >> SECTOR_BITS);
}

function tileKey(map, x, y) {
  return ((map & 0x0f) * 0x20000000) + ((y & 0x0fff) * 0x2000) + (x & 0x1fff);
}

export class SectorIndex {
  constructor() {
    /** @type {Map<number, { mobiles: Set<number>, items: Set<number>, players: Set<number> }>} */
    this._buckets = new Map();
    // Per-entity reverse index so we can de-register on move without a
    // bucket scan. Stores the LAST sector key the entity was placed in.
    /** @type {Map<number, number>} */
    this._mobAt = new Map();
    /** @type {Map<number, number>} */
    this._itAt = new Map();
    /** Connected mobiles only. Kept separate from `_mobAt` so AI/spawners
     * can answer presence queries without resolving every NPC candidate. */
    this._onlineAt = new Map();
    this._tileItems = new Map();
    this._itTile = new Map();
    this._revisions = new Map();
    this._globalRevision = 1;
    this._collisionRevisions = new Map();
    this._collisionGlobalRevision = 1;
    this._queryStats = {
      calls: 0, candidates: 0, totalMs: 0, maxMs: 0,
      mobileCalls: 0, itemCalls: 0, tileCalls: 0, timedSamples: 0,
    };
    this._incrementalValidation = null;
    this._validationCycles = 0;
  }

  _bump(k) {
    if (k === undefined) return;
    this._globalRevision = (this._globalRevision + 1) >>> 0 || 1;
    this._revisions.set(k, this._globalRevision);
  }

  _bumpCollision(k) {
    this._bump(k);
    if (k === undefined) return;
    this._collisionGlobalRevision = (this._collisionGlobalRevision + 1) >>> 0 || 1;
    this._collisionRevisions.set(k, this._collisionGlobalRevision);
  }

  _bucket(map, sx, sy, create = false) {
    const k = key(map, sx, sy);
    let b = this._buckets.get(k);
    if (!b && create) {
      b = { mobiles: new Set(), items: new Set(), players: new Set() };
      this._buckets.set(k, b);
    }
    return b;
  }

  _dropBucketIfEmpty(k, b) {
    if (b && b.mobiles.size === 0 && b.items.size === 0 && b.players.size === 0) {
      this._buckets.delete(k);
    }
  }

  // ---------- Mobile membership -----------------------------------------

  addMobile(mob) {
    if (!mob) return false;
    // Bug-hunt #12 B4 — reject out-of-bounds before sector-bucket math.
    // A negative x (briefly seen during dismount / boat de-board before
    // resolveStandingZ runs) would `>> 3` to -1 then mask via `& 0x7FF`
    // to 2047, bucketing the mob in a far-edge sector forever.
    const mx = mob.x | 0, my = mob.y | 0;
    if (mx < 0 || mx > 7167 || my < 0 || my > 4095) {
      this.removeMobile(mob.serial);
      return false;
    }
    const sx = mx >> SECTOR_BITS;
    const sy = my >> SECTOR_BITS;
    const k = key(mob.map | 0, sx, sy);
    const old = this._mobAt.get(mob.serial);
    if (old === k) {
      const existing = this._bucket(mob.map | 0, sx, sy, true);
      if (!existing.mobiles.has(mob.serial)) {
        existing.mobiles.add(mob.serial);
        this._bump(k);
      }
      if (this._onlineAt.has(mob.serial) || mob.client) this.markMobileOnline(mob);
      return false;
    }
    if (old !== undefined) {
      const ob = this._buckets.get(old);
      if (ob) {
        ob.mobiles.delete(mob.serial);
        ob.players.delete(mob.serial);
        this._bump(old);
        this._dropBucketIfEmpty(old, ob);
      }
    }
    const b = this._bucket(mob.map | 0, sx, sy, true);
    b.mobiles.add(mob.serial);
    this._mobAt.set(mob.serial, k);
    if (this._onlineAt.has(mob.serial) || mob.client) {
      b.players.add(mob.serial);
      this._onlineAt.set(mob.serial, k);
    }
    this._bump(k);
    return true;
  }

  moveMobile(mob) {
    // Interest wake-ups are needed only when a player crosses an 8×8 sector
    // boundary. Calling them for every walk packet turned one move into a
    // 48-tile AI scan even though the nearby set had not materially changed.
    this.onMobileUpdated?.(mob);
    if (this.addMobile(mob)) this.onMobileMoved?.(mob);
  }

  removeMobile(serial) {
    const k = this._mobAt.get(serial);
    if (k === undefined) return;
    const b = this._buckets.get(k);
    if (b) {
      b.mobiles.delete(serial);
      b.players.delete(serial);
      this._bump(k);
      this._dropBucketIfEmpty(k, b);
    }
    this._mobAt.delete(serial);
    this._onlineAt.delete(serial);
  }

  markMobileOnline(mob) {
    if (!mob?.serial) return false;
    const serial = mob.serial >>> 0;
    if (!this._mobAt.has(serial)) this.addMobile(mob);
    const k = this._mobAt.get(serial);
    const bucket = this._buckets.get(k);
    if (k === undefined || !bucket) return false;
    const changed = !bucket.players.has(serial) || this._onlineAt.get(serial) !== k;
    bucket.players.add(serial);
    this._onlineAt.set(serial, k);
    if (changed) this._bump(k);
    return changed;
  }

  markMobileOffline(mobOrSerial) {
    const serial = (typeof mobOrSerial === 'number' ? mobOrSerial : mobOrSerial?.serial) >>> 0;
    const k = this._onlineAt.get(serial);
    if (k === undefined) return false;
    const bucket = this._buckets.get(k);
    bucket?.players.delete(serial);
    this._onlineAt.delete(serial);
    this._bump(k);
    this._dropBucketIfEmpty(k, bucket);
    return true;
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
    const tileChanged = oldTile !== tk;
    if (tileChanged) {
      const oldSet = this._tileItems.get(oldTile);
      oldSet?.delete(item.serial);
      if (oldSet?.size === 0) this._tileItems.delete(oldTile);
      const set = this._tileItems.get(tk) ?? new Set();
      set.add(item.serial); this._tileItems.set(tk, set); this._itTile.set(item.serial, tk);
    }
    if (old === k) {
      const existing = this._bucket(item.map | 0, sx, sy, true);
      const membershipMissing = !existing.items.has(item.serial);
      if (membershipMissing) existing.items.add(item.serial);
      if (tileChanged || membershipMissing) this._bumpCollision(k);
      return;
    }
    if (old !== undefined) {
      const ob = this._buckets.get(old);
      if (ob) {
        ob.items.delete(item.serial);
        this._bumpCollision(old);
        this._dropBucketIfEmpty(old, ob);
      }
    }
    const b = this._bucket(item.map | 0, sx, sy, true);
    b.items.add(item.serial);
    this._itAt.set(item.serial, k);
    this._bumpCollision(k);
  }

  moveItem(item) { this.onItemUpdated?.(item); this.addItem(item); }

  removeItem(serial) {
    const k = this._itAt.get(serial);
    if (k === undefined) return;
    const b = this._buckets.get(k);
    if (b) {
      b.items.delete(serial);
      this._bumpCollision(k);
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
    this._onlineAt.clear();
    this._tileItems.clear();
    this._itTile.clear();
    this._revisions.clear();
    this._collisionRevisions.clear();
    this._globalRevision = (this._globalRevision + 1) >>> 0 || 1;
    this._collisionGlobalRevision = (this._collisionGlobalRevision + 1) >>> 0 || 1;
    this._incrementalValidation = null;
  }

  // ---------- Queries ---------------------------------------------------

  /** Iterate sector keys covering the rectangle min..max. */
  *_sectorKeysInRange(map, x, y, range) {
    // Clamp before shifting. Negative sectors would otherwise wrap through
    // the packed-key masks and every edge query would probe nonexistent
    // buckets on the opposite side of the 11-bit key space.
    const sx0 = Math.max(0, (x - range) | 0) >> SECTOR_BITS;
    const sy0 = Math.max(0, (y - range) | 0) >> SECTOR_BITS;
    const sx1 = Math.min(7167, (x + range) | 0) >> SECTOR_BITS;
    const sy1 = Math.min(4095, (y + range) | 0) >> SECTOR_BITS;
    for (let sx = sx0; sx <= sx1; sx++) {
      for (let sy = sy0; sy <= sy1; sy++) {
        yield key(map | 0, sx, sy);
      }
    }
  }

  sectorKeysNear(map, x, y, range) { return [...this._sectorKeysInRange(map, x, y, range)]; }

  /** Yield every mobile serial whose home sector overlaps the range. */
  *mobileSerialsNear(map, x, y, range) {
    const started = this._beginQuery('mobileCalls');
    let candidates = 0;
    try {
      for (const k of this._sectorKeysInRange(map, x, y, range)) {
        const b = this._buckets.get(k);
        if (!b) continue;
        for (const s of b.mobiles) { candidates++; yield s; }
      }
    } finally { this._finishQuery(started, candidates); }
  }

  /** Yield connected-player serials only. This is the hot path for AI LOD,
   * spawn proximity and area fan-out. */
  *onlineMobileSerialsNear(map, x, y, range) {
    const started = this._beginQuery('mobileCalls');
    let candidates = 0;
    try {
      for (const k of this._sectorKeysInRange(map, x, y, range)) {
        const bucket = this._buckets.get(k);
        if (!bucket) continue;
        for (const serial of bucket.players) { candidates++; yield serial; }
      }
    } finally { this._finishQuery(started, candidates); }
  }

  nearestOnlineDistance(world, map, x, y, range) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const serial of this.onlineMobileSerialsNear(map, x, y, range)) {
      const hot = world?.hotMobiles;
      const slot = hot?.slotBySerial?.get(serial);
      let mx; let my; let mobileMap;
      if (slot != null) {
        mx = hot.x[slot]; my = hot.y[slot]; mobileMap = hot.map[slot];
      } else {
        const mobile = world?.mobiles?.get(serial);
        if (!mobile?.client) continue;
        mx = mobile.x; my = mobile.y; mobileMap = mobile.map;
      }
      if (mobileMap !== map) continue;
      const distance = Math.max(Math.abs(mx - x), Math.abs(my - y));
      if (distance <= range && distance < nearest) nearest = distance;
    }
    return nearest;
  }

  onlineCountNear(world, map, x, y, range, rect = null) {
    let count = 0;
    for (const serial of this.onlineMobileSerialsNear(map, x, y, range)) {
      const hot = world?.hotMobiles;
      const slot = hot?.slotBySerial?.get(serial);
      let mx; let my; let mobileMap;
      if (slot != null) {
        mx = hot.x[slot]; my = hot.y[slot]; mobileMap = hot.map[slot];
      } else {
        const mobile = world?.mobiles?.get(serial);
        if (!mobile?.client) continue;
        mx = mobile.x; my = mobile.y; mobileMap = mobile.map;
      }
      if (mobileMap !== map) continue;
      if (rect && (mx < rect.x1 || mx > rect.x2 || my < rect.y1 || my > rect.y2)) continue;
      if (!rect && (Math.abs(mx - x) > range || Math.abs(my - y) > range)) continue;
      count++;
    }
    return count;
  }

  /** Yield every grounded-item serial whose home sector overlaps. */
  *itemSerialsNear(map, x, y, range) {
    const started = this._beginQuery('itemCalls');
    let candidates = 0;
    try {
      for (const k of this._sectorKeysInRange(map, x, y, range)) {
        const b = this._buckets.get(k);
        if (!b) continue;
        for (const s of b.items) { candidates++; yield s; }
      }
    } finally { this._finishQuery(started, candidates); }
  }

  /** Yield grounded-item serials from the sectors intersecting an exact
   *  axis-aligned rectangle. This avoids turning a long, narrow editor
   *  selection into an enormous square `itemSerialsNear` query. Callers
   *  still filter exact item coordinates because edge sectors overlap. */
  *itemSerialsInRect(map, x0, y0, x1, y1) {
    const started = this._beginQuery('itemCalls');
    let candidates = 0;
    const sx0 = Math.max(0, Math.floor(Math.min(x0, x1) / SECTOR_SIZE));
    const sy0 = Math.max(0, Math.floor(Math.min(y0, y1) / SECTOR_SIZE));
    const sx1 = Math.min(0x7ff, Math.floor(Math.max(x0, x1) / SECTOR_SIZE));
    const sy1 = Math.min(0x7ff, Math.floor(Math.max(y0, y1) / SECTOR_SIZE));
    try {
      for (let sx = sx0; sx <= sx1; sx++) for (let sy = sy0; sy <= sy1; sy++) {
        const bucket = this._buckets.get(key(map, sx, sy));
        if (!bucket) continue;
        for (const serial of bucket.items) { candidates++; yield serial; }
      }
    } finally { this._finishQuery(started, candidates); }
  }

  /** Single-tile lookup for runtimeSolidAt-style hot paths. */
  *itemSerialsAt(map, x, y) {
    const started = this._beginQuery('tileCalls');
    let candidates = 0;
    try {
      for (const serial of this._tileItems.get(tileKey(map | 0, x | 0, y | 0)) ?? []) {
        candidates++;
        yield serial;
      }
    } finally { this._finishQuery(started, candidates); }
  }

  _beginQuery(kind) {
    const q = this._queryStats;
    q.calls++;
    q[kind]++;
    // Timing every spatial lookup made the profiler itself visible in A*
    // and movement profiles. Cardinalities remain exact; wall-time is a
    // representative 1/64 sample and is labelled as such in diagnostics.
    return (q.calls & 63) === 1 ? performance.now() : -1;
  }

  _finishQuery(started, candidates) {
    this._queryStats.candidates += candidates;
    if (started < 0) return;
    const ms = Math.max(0, performance.now() - started);
    this._queryStats.totalMs += ms;
    this._queryStats.maxMs = Math.max(this._queryStats.maxMs, ms);
    this._queryStats.timedSamples++;
  }

  revisionForRange(map, x, y, range) {
    let revision = 0;
    for (const k of this._sectorKeysInRange(map, x, y, range)) revision = Math.max(revision, this._revisions.get(k) ?? 0);
    return revision;
  }

  collisionRevisionForRange(map, x, y, range) {
    let revision = 0;
    for (const k of this._sectorKeysInRange(map, x, y, range)) revision = Math.max(revision, this._collisionRevisions.get(k) ?? 0);
    return revision;
  }

  get revision() { return this._globalRevision; }

  /** Diagnostic — for tests / admin. */
  stats() {
    let nb = 0, nm = 0, ni = 0, np = 0;
    for (const b of this._buckets.values()) {
      nb++; nm += b.mobiles.size; ni += b.items.size; np += b.players.size;
    }
    const q = this._queryStats;
    return { buckets: nb, tileBuckets: this._tileItems.size, mobiles: nm, items: ni, onlinePlayers: np,
      revision: this._globalRevision, sectorSize: SECTOR_SIZE,
      collisionRevision: this._collisionGlobalRevision,
      validationCycles: this._validationCycles,
      queries: { ...q,
        averageMs: q.timedSamples ? Number((q.totalMs / q.timedSamples).toFixed(4)) : 0,
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
    for (const [serial, k] of this._onlineAt) {
      const mobile = world?.mobiles?.get(serial);
      if (!mobile?.client || !this._buckets.get(k)?.players.has(serial)) issues.push({ kind: 'online-mobile', serial });
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
    for (const serial of world?._onlineMobiles ?? []) {
      if (!this._onlineAt.has(serial)) issues.push({ kind: 'missing-online-mobile', serial });
    }
    if (repair && issues.length) this.rebuild(world);
    return { ok: issues.length === 0, issues, repaired: !!(repair && issues.length) };
  }

  /**
   * Validate the same invariants as `validate`, but spend at most `budget`
   * entity checks per call. Map iterators remain valid across ordinary
   * insert/delete operations, so no O(world-size) snapshot is allocated.
   * Repairs are local and never rebuild the complete index mid-game.
   */
  validateIncremental(world, { repair = true, budget = 1024, maxIssues = 100 } = {}) {
    const limit = Math.max(1, budget | 0);
    let state = this._incrementalValidation;
    if (!state) {
      state = this._incrementalValidation = {
        phase: 0, iterator: this._mobAt.entries(), checked: 0,
        cycleIssues: 0, repaired: 0, samples: [], startedAt: performance.now(),
      };
    }
    const addIssue = (kind, serial, fix) => {
      state.cycleIssues++;
      if (state.samples.length < maxIssues) state.samples.push({ kind, serial: serial >>> 0 });
      if (repair) {
        try { fix?.(); state.repaired++; } catch { /* next cycle retries */ }
      }
    };
    let checked = 0;
    while (checked < limit && state.phase < 6) {
      const next = state.iterator.next();
      if (next.done) {
        state.phase++;
        state.iterator = state.phase === 1 ? this._itAt.entries()
          : state.phase === 2 ? (world?.mobiles?.values?.() ?? [])[Symbol.iterator]()
            : state.phase === 3 ? (world?.items?.values?.() ?? [])[Symbol.iterator]()
              : state.phase === 4 ? this._onlineAt.entries()
                : state.phase === 5 ? (world?._onlineMobiles ?? [])[Symbol.iterator]()
                  : [][Symbol.iterator]();
        continue;
      }
      checked++; state.checked++;
      if (state.phase === 0) {
        const [serial, indexedKey] = next.value;
        const mobile = world?.mobiles?.get(serial);
        const expected = mobile ? key(mobile.map | 0, (mobile.x | 0) >> SECTOR_BITS, (mobile.y | 0) >> SECTOR_BITS) : undefined;
        if (!mobile || indexedKey !== expected || !this._buckets.get(indexedKey)?.mobiles.has(serial)) {
          addIssue('mobile', serial, () => mobile ? this.addMobile(mobile) : this.removeMobile(serial));
        }
      } else if (state.phase === 1) {
        const [serial, indexedKey] = next.value;
        const item = world?.items?.get(serial);
        const expected = item && !item.parent ? key(item.map | 0, (item.x | 0) >> SECTOR_BITS, (item.y | 0) >> SECTOR_BITS) : undefined;
        const expectedTile = item && !item.parent ? tileKey(item.map | 0, item.x | 0, item.y | 0) : undefined;
        if (!item || item.parent || indexedKey !== expected || !this._buckets.get(indexedKey)?.items.has(serial)
            || this._itTile.get(serial) !== expectedTile || !this._tileItems.get(expectedTile)?.has(serial)) {
          addIssue('item', serial, () => item ? this.addItem(item) : this.removeItem(serial));
        }
      } else if (state.phase === 2) {
        const mobile = next.value;
        if (!this._mobAt.has(mobile.serial)) addIssue('missing-mobile', mobile.serial, () => this.addMobile(mobile));
      } else if (state.phase === 3) {
        const item = next.value;
        if (!item.parent && !this._itAt.has(item.serial)) addIssue('missing-item', item.serial, () => this.addItem(item));
        else if (item.parent && this._itAt.has(item.serial)) addIssue('parented-item', item.serial, () => this.removeItem(item.serial));
      } else if (state.phase === 4) {
        const [serial, indexedKey] = next.value;
        const mobile = world?.mobiles?.get(serial);
        if (!mobile?.client || !this._buckets.get(indexedKey)?.players.has(serial)) {
          addIssue('online-mobile', serial, () => mobile?.client ? this.markMobileOnline(mobile) : this.markMobileOffline(serial));
        }
      } else {
        const serial = next.value >>> 0;
        const mobile = world?.mobiles?.get(serial);
        if (mobile?.client && !this._onlineAt.has(serial)) addIssue('missing-online-mobile', serial, () => this.markMobileOnline(mobile));
      }
    }
    if (state.phase < 6) {
      return { ok: true, complete: false, checked, cycleChecked: state.checked, issues: [], repaired: false };
    }
    this._incrementalValidation = null;
    this._validationCycles++;
    return {
      ok: state.cycleIssues === 0,
      complete: true,
      checked,
      cycleChecked: state.checked,
      issues: state.samples,
      issueCount: state.cycleIssues,
      repaired: state.repaired > 0,
      repairedCount: state.repaired,
      ms: Number((performance.now() - state.startedAt).toFixed(3)),
    };
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
