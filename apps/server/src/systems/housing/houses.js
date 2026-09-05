// Houses — foundation registry + ACL + lockdown tracking + decay.

import { createItem, destroyItem } from '../../world/items.js';
import { nearbyClients } from '../../world/visibility.js';
//
// ServUO `HouseFoundationData` enumerates per-style item caps. The
// table below mirrors the canonical values: a Small Stone Workshop
// caps at 425 lockdowns + 4 secure containers, a Castle at 3375 +
// 34. We seed each new house with the cap based on its foundation
// string; canLockDown / canSecure read these.

const FOUNDATION_CAPS = {
  // Small (425/4)
  'small-stone':      { lockdowns: 425, secures: 4 },
  'small-marble':     { lockdowns: 540, secures: 5 },
  'small-brick':      { lockdowns: 540, secures: 5 },
  'stone-tower':      { lockdowns: 580, secures: 6 },
  'log-cabin':        { lockdowns: 540, secures: 5 },
  'sandstone':        { lockdowns: 540, secures: 5 },
  // Medium
  'villa':            { lockdowns: 1110, secures: 11 },
  'stone-cottage':    { lockdowns: 1230, secures: 12 },
  'brick-house':      { lockdowns: 1310, secures: 13 },
  '2-story-cottage':  { lockdowns: 1369, secures: 14 },
  '2-story-tower':    { lockdowns: 1378, secures: 14 },
  '2-story-stone':    { lockdowns: 1499, secures: 15 },
  'l-shape-stone':    { lockdowns: 1499, secures: 15 },
  '2-story-marble':   { lockdowns: 1499, secures: 15 },
  // Large
  '3-story-brick':    { lockdowns: 1859, secures: 19 },
  'keep':             { lockdowns: 2625, secures: 26 },
  'castle':           { lockdowns: 3375, secures: 34 },
};
// Audit #43 P2-13 — ServUO `BaseHouse.cs:27 GlobalBonusStorageScalar = 1.4`
// (SA era). Every cap (lockdowns/secures/vendors) gets multiplied. Was:
// hard-coded base values → caps at ~70% of where they should be.
const SA_STORAGE_SCALAR = 1.4;

function capsFor(foundation) {
  const base = FOUNDATION_CAPS[String(foundation ?? '').toLowerCase()]
    ?? FOUNDATION_CAPS['small-stone'];
  return {
    lockdowns: Math.floor(base.lockdowns * SA_STORAGE_SCALAR),
    secures:   Math.floor(base.secures   * SA_STORAGE_SCALAR),
  };
}
//
// Decay model mirrors ServUO `BaseHouse.cs` decay tier ladder:
//   New             freshly placed, immune for 7 days
//   LikeNew         touched within 30 days
//   Slightly        touched within 60 days
//   Somewhat        touched within 90 days
//   Fairly          touched within 120 days
//   Greatly         touched within 150 days
//   IDOC            "in danger of collapsing" — visible flag for would-be
//                   looters; demolished after 5 days idle in this tier
//
// "Touched" means the owner / co-owner logged into the world while the
// house exists. We re-stamp `lastTouchedAt` on every login from
// auth.bindMobileToAccount. Decay only ticks when the timer fires; the
// rest of the time it's a static field.
//
// Vendor placement — house owners may set `house.vendors[]` with the
// serials of mob NPCs the owner has hired. Vendors live INSIDE the
// house rect and sell via the regular vendor system. The house ACL
// prevents non-owners from removing them.
//
// Houses are indexed by exact multi footprint (with rectangular fallback for
// legacy saves). Canonical multi components remain compact on their anchor;
// authored custom pieces are materialized as ordinary immovable world items.
// The registry snapshot is committed in the same SQLite generation as the
// world, keeping ACL, decay, lockdown and design state crash-consistent.

/**
 * @typedef {Object} House
 * @property {number} id
 * @property {number} ownerSerial
 * @property {string} ownerName
 * @property {number} map
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 * @property {Set<number>} coowners
 * @property {Set<number>} friends
 * @property {Set<number>} bans
 * @property {Set<number>} lockdowns  serials of items locked down
 * @property {number} createdAt
 */

export class HouseRegistry {
  constructor() {
    /** @type {Map<number, House>} */
    this.houses = new Map();
    // Per-instance counter — survives a save/load round-trip via
    // persistence.loadHousesSync which restores it to max(seen)+1.
    // Keeping it on the instance (vs. module-scope) means tests that
    // spin up multiple registries don't bleed ids between them.
    this.nextHouseId = 1;
    this.world = null;
    this._decayHandler = null;
    this._byOwner = new Map();
    this._byInstance = new Map();
    this._bySerial = new Map();
    this._bySector = new Map();
    this._customPieces = null;
  }

  /** Attach the live world so committed custom-house tiles become visible. */
  attachWorld(world) {
    this.world = world ?? null;
    if (this.world) this.world._houseRegistry = this;
    return this;
  }

  setDecayHandler(handler) {
    this._decayHandler = typeof handler === 'function' ? handler : null;
    return this._decayHandler;
  }

  _sectorKey(map, x, y) { return `${map | 0}:${(x | 0) >> 4}:${(y | 0) >> 4}`; }

  _indexHouse(house) {
    if (!house) return;
    const owner = house.ownerSerial >>> 0;
    let owned = this._byOwner.get(owner);
    if (!owned) { owned = new Set(); this._byOwner.set(owner, owned); }
    owned.add(house.id);
    if (house.multiInstance != null) this._byInstance.set(house.multiInstance >>> 0, house.id);
    if (house.multiSerial != null) this._bySerial.set(house.multiSerial >>> 0, house.id);
    const keys = new Set();
    for (let y = (house.y1 | 0) >> 4; y <= (house.y2 | 0) >> 4; y++) {
      for (let x = (house.x1 | 0) >> 4; x <= (house.x2 | 0) >> 4; x++) {
        const key = `${house.map | 0}:${x}:${y}`;
        keys.add(key);
        let bucket = this._bySector.get(key);
        if (!bucket) { bucket = new Set(); this._bySector.set(key, bucket); }
        bucket.add(house.id);
      }
    }
    Object.defineProperty(house, '_sectorKeys', { value: keys, writable: true, configurable: true });
    if (Array.isArray(house.footprint) && house.footprint.length) {
      Object.defineProperty(house, '_footprintKeys', {
        value: new Set(house.footprint.map((cell) => `${cell[0] | 0}:${cell[1] | 0}`)),
        writable: true, configurable: true,
      });
    }
  }

  _unindexHouse(house) {
    if (!house) return;
    const owned = this._byOwner.get(house.ownerSerial >>> 0);
    owned?.delete(house.id);
    if (owned?.size === 0) this._byOwner.delete(house.ownerSerial >>> 0);
    if (house.multiInstance != null) this._byInstance.delete(house.multiInstance >>> 0);
    if (house.multiSerial != null) this._bySerial.delete(house.multiSerial >>> 0);
    for (const key of house._sectorKeys ?? []) {
      const bucket = this._bySector.get(key);
      bucket?.delete(house.id);
      if (bucket?.size === 0) this._bySector.delete(key);
    }
  }

  rebuildIndexes() {
    this._byOwner.clear(); this._byInstance.clear(); this._bySerial.clear(); this._bySector.clear();
    for (const house of this.houses.values()) this._indexHouse(house);
    return this.houses.size;
  }

  markChanged() {
    this.world?.mutationJournal?.markMetaDirty?.();
  }

  setCustomPieceCatalog(catalog) {
    if (!catalog || typeof catalog !== 'object') { this._customPieces = null; return 0; }
    const pieces = new Map();
    const walk = (value, kind) => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, kind);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        const nextKind = key === 'teleprts'
          ? 'teleport'
          : ['walls', 'doors', 'floors', 'stairs', 'roofs', 'misc', 'teleports'].includes(key)
            ? key.replace(/s$/, '') : kind;
        if (key === 'pieces' && Array.isArray(entry)) {
          for (const graphic of entry) if (Number.isInteger(graphic) && graphic > 0) pieces.set(graphic >>> 0, nextKind ?? 'item');
        } else if (key === 'tileNumber' && Number.isInteger(entry) && entry > 0) {
          pieces.set(entry >>> 0, nextKind ?? 'item');
        } else walk(entry, nextKind);
      }
    };
    walk(catalog, null);
    this._customPieces = pieces;
    return pieces.size;
  }

  /** Resolve a classic 0xD7 graphic to its authored behavior category. */
  customPieceKind(graphic, fallback = 'item') {
    return this._customPieces?.get?.(Number(graphic) >>> 0) ?? fallback;
  }

  _customLimit(house) {
    const area = Math.max(1, ((house?.x2 | 0) - (house?.x1 | 0) + 1)
      * ((house?.y2 | 0) - (house?.y1 | 0) + 1));
    return Math.min(4096, Math.max(256, area * 8));
  }

  _allowCustomMutation(house, amount = 1) {
    const editing = house?.editing;
    if (!editing || editing.tiles.length + amount > this._customLimit(house)) return false;
    const now = Date.now();
    if (now - (editing.rateWindowAt ?? 0) >= 1000) {
      editing.rateWindowAt = now;
      editing.rateCount = 0;
    }
    editing.rateCount = (editing.rateCount ?? 0) + 1;
    return editing.rateCount <= 120;
  }

  _validCustomPiece(kind, graphic, x, y, z, house) {
    if (!Number.isInteger(graphic) || graphic <= 0 || graphic > 0xffff) return false;
    if (x < house.x1 - 1 || x > house.x2 + 1 || y < house.y1 - 1 || y > house.y2 + 1) return false;
    if (z < (house.z | 0) - 20 || z > (house.z | 0) + 100) return false;
    if (!this._customPieces?.size) return true;
    const catalogKind = this._customPieces.get(graphic >>> 0);
    if (!catalogKind) return false;
    const normalized = String(kind ?? 'item').replace(/s$/, '');
    return normalized === 'item' || normalized === 'misc' || catalogKind === normalized
      || (normalized === 'stair' && catalogKind === 'stair');
  }

  /**
   * Create a new house owned by `owner`. Returns the house record.
   * Caller must check overlap with `houseAt(x, y, map)` before calling.
   */
  place(owner, opts) {
    const { x1, y1, x2, y2, map = 1 } = opts;
    const id = this.nextHouseId++;
    /** @type {House} */
    const house = {
      id,
      ownerSerial: owner.serial >>> 0,
      ownerName: owner.name ?? 'Unknown',
      map, x1, y1, x2, y2,
      z: opts.z | 0,
      coowners: new Set(),
      friends: new Set(),
      bans: new Set(),
      lockdowns: new Set(),
      secures: new Set(),
      vendors: new Set(),
      createdAt: Date.now(),
      lastTouchedAt: Date.now(),
      sign: opts.sign ?? {
        x: x1, y: y2 + 1, z: opts.z | 0,
        title: opts.title ?? 'Small Stone House',
      },
      foundation: opts.foundation ?? 'small-stone',
      multiId: opts.multiId == null ? null : (opts.multiId | 0),
      multiSerial: opts.multiSerial == null ? null : (opts.multiSerial >>> 0),
      multiInstance: opts.multiInstance == null ? null : (opts.multiInstance >>> 0),
      // Registry-created foundations are customizable unless the caller
      // explicitly marks a deed-based classic multi as immutable.
      customizable: opts.customizable !== false,
      source: opts.source ?? 'registry',
      customItemSerials: [],
      footprint: Array.isArray(opts.footprint)
        ? opts.footprint.map((cell) => [cell[0] | 0, cell[1] | 0]) : null,
    };
    // Seed item caps from the foundation table. Stored on the house so
    // future code (deed upgrades, GM gump) can mutate without re-deriving.
    const caps = capsFor(house.foundation);
    house.lockdownCap = caps.lockdowns;
    house.secureCap   = caps.secures;
    this.houses.set(id, house);
    this._indexHouse(house);
    this.markChanged();
    return house;
  }

  /** Stamp the touch timestamp — extends the decay ladder one tick. */
  touch(house, now = Date.now()) {
    house.lastTouchedAt = now;
    this.markChanged();
  }

  /**
   * Compute the decay tier of `house` at time `now`. Returns one of:
   *   'New' | 'LikeNew' | 'Slightly' | 'Somewhat' | 'Fairly' |
   *   'Greatly' | 'IDOC' | 'Collapsed'
   */
  decayOf(house, now = Date.now()) {
    const ageMs = now - (house.lastTouchedAt ?? house.createdAt);
    const day = 86400000;
    if (ageMs < 7 * day)   return 'New';
    if (ageMs < 30 * day)  return 'LikeNew';
    if (ageMs < 60 * day)  return 'Slightly';
    if (ageMs < 90 * day)  return 'Somewhat';
    if (ageMs < 120 * day) return 'Fairly';
    if (ageMs < 150 * day) return 'Greatly';
    if (ageMs < 155 * day) return 'IDOC';
    return 'Collapsed';
  }

  /**
   * Sweep the registry — collapse every house whose decay tier reads
   * 'Collapsed'. Caller handles content (ground-drop vs delete).
   * Returns array of removed houses.
   */
  sweepDecay(now = Date.now()) {
    const removed = [];
    for (const h of [...this.houses.values()]) {
      if (this.decayOf(h, now) === 'Collapsed') {
        // Physical teardown must succeed before the registry record goes
        // away. Returning false leaves the house intact for a later retry.
        if (this._decayHandler && this._decayHandler(h) === false) continue;
        this._unindexHouse(h);
        this.houses.delete(h.id);
        this.markChanged();
        removed.push(h);
      }
    }
    return removed;
  }

  // ---------- Vendor placement ----------------------------------------
  // ServUO `BaseHouse.CheckVendorPlacement` — owner can place
  // (baseSlots + tradeSkill/15) vendors. baseSlots scales with the
  // foundation size; small-stone caps at 4, castle at 30. Each
  // placement also stamps a daily rent timestamp on the vendor — the
  // periodic vendor sweep (player-vendor.js) deducts the gold.
  /** Maximum vendor placements for this house. */
  vendorCapFor(house) {
    const FOUNDATION_VENDOR_BASE = {
      'small-stone': 4, 'small-marble': 4, 'small-brick': 4,
      'stone-tower': 6, 'log-cabin': 6, 'sandstone': 6,
      'villa': 8, 'stone-cottage': 8, 'brick-house': 8,
      '2-story-cottage': 10, '2-story-tower': 10, '2-story-stone': 10,
      'l-shape-stone': 10, '2-story-marble': 10,
      '3-story-brick': 14, 'keep': 20, 'castle': 30,
    };
    return FOUNDATION_VENDOR_BASE[String(house.foundation ?? '').toLowerCase()] ?? 4;
  }
  /**
   * Check whether `mob` may add another vendor to `house`. Owner +
   * co-owners can place. Returns true if under cap. Sends a system
   * message to mob.client on rejection (so the gump can surface it).
   */
  canAddVendor(house, mob) {
    const role = this.roleOf(house, mob.serial);
    if (role !== 'owner' && role !== 'coowner') return false;
    const cap = this.vendorCapFor(house);
    if ((house.vendors?.size ?? 0) >= cap) {
      mob.client?.sendSystemMessage?.(
        `This house has reached its vendor limit (${cap}).`);
      return false;
    }
    return true;
  }
  addVendor(house, vendorSerial, options = {}) {
    house.vendors.add(vendorSerial >>> 0);
    // Stamp the placement timestamp on the house's vendor record so
    // the daily rent sweep can deduct 60 gp/day from the vendor's
    // till. Stored as a Map keyed by serial.
    house._vendorMeta ||= new Map();
    house._vendorMeta.set(vendorSerial >>> 0, {
      placedAt: options.placedAt ?? Date.now(),
      lastRentAt: options.placedAt ?? Date.now(),
    });
    this.markChanged();
  }
  removeVendor(house, vendorSerial) {
    house.vendors.delete(vendorSerial >>> 0);
    house._vendorMeta?.delete?.(vendorSerial >>> 0);
    this.markChanged();
  }
  vendorsOf(house) { return [...house.vendors]; }

  /**
   * Sweep — deduct one day's rent (60 gp default) from each vendor
   * whose last-rent timestamp is older than 24 h. ServUO uses
   * `PlayerVendor.ChargeRent` cadence (called from the same daily
   * scheduler). When the vendor lacks gold to pay, mark for
   * dismissal — the caller (player-vendor sweep) removes them.
   *
   * @param {number} now
   * @returns {Array<{ houseId:number, vendorSerial:number, paid:boolean }>}
   */
  sweepVendorRent(now = Date.now()) {
    const DAILY_MS = 24 * 60 * 60 * 1000;
    const RENT_GOLD = 60;
    const out = [];
    for (const h of this.houses.values()) {
      if (!h._vendorMeta) continue;
      for (const [serial, meta] of h._vendorMeta) {
        if (now - (Number(meta.lastRentAt) || 0) < DAILY_MS) continue;
        // Bug-hunt #7 B5: do NOT stamp lastRentAt here. The caller may
        // fail to collect (vendor till empty); without delaying the
        // timestamp, an unpaid vendor goes another 24h before retry and
        // the dismissal-after-N-failures path never accumulates strikes.
        // Caller is expected to set `meta.lastRentAt = now` only after
        // it has actually deducted the gold (or chosen to dismiss).
        out.push({ houseId: h.id, vendorSerial: serial, due: RENT_GOLD, meta });
      }
    }
    return out;
  }

  remove(id) {
    const house = this.houses.get(id | 0);
    if (!house) return false;
    this._unindexHouse(house);
    const removed = this.houses.delete(id | 0);
    if (removed) this.markChanged();
    return removed;
  }

  /**
   * Drop every dynamic house record during an explicit world wipe.
   * World entities belonging to each house are removed by the normal item /
   * mobile destruction pipeline; this method clears the separate registry and
   * resets its monotonic id source so the following CreateWorld starts from a
   * genuinely empty housing state.
   */
  reset() {
    const removed = this.houses.size;
    this.houses.clear();
    this._byOwner.clear(); this._byInstance.clear(); this._bySerial.clear(); this._bySector.clear();
    this.nextHouseId = 1;
    this.markChanged();
    return removed;
  }

  get(id) { return this.houses.get(id | 0) ?? null; }

  /** Compact JSON-safe representation embedded in world.sqlite metadata. */
  snapshot() {
    const rows = [];
    for (const h of this.houses.values()) rows.push({
      id: h.id | 0,
      ownerSerial: h.ownerSerial >>> 0,
      ownerName: h.ownerName ?? 'Unknown',
      map: h.map | 0, x1: h.x1 | 0, y1: h.y1 | 0, x2: h.x2 | 0, y2: h.y2 | 0, z: h.z | 0,
      coowners: [...(h.coowners ?? [])], friends: [...(h.friends ?? [])], bans: [...(h.bans ?? [])],
      lockdowns: [...(h.lockdowns ?? [])], secures: [...(h.secures ?? [])], vendors: [...(h.vendors ?? [])],
      vendorMeta: h._vendorMeta instanceof Map ? [...h._vendorMeta] : [],
      createdAt: h.createdAt, lastTouchedAt: h.lastTouchedAt,
      sign: h.sign ?? null, foundation: h.foundation ?? null,
      multiId: h.multiId ?? null, multiSerial: h.multiSerial ?? null,
      multiInstance: h.multiInstance ?? null, customizable: h.customizable === true,
      source: h.source ?? 'registry', isPublic: h.isPublic === true,
      tiles: this._cloneCustomTiles(h.tiles), revision: h.revision | 0,
      customTemplates: h.customTemplates ?? {},
      lockdownCap: h.lockdownCap ?? null, secureCap: h.secureCap ?? null,
      spawnedItems: [...(h.spawnedItems ?? [])], customItemSerials: [...(h.customItemSerials ?? [])],
      footprint: Array.isArray(h.footprint) ? h.footprint.map((cell) => [cell[0] | 0, cell[1] | 0]) : null,
    });
    return { version: 1, nextHouseId: this.nextHouseId | 0, houses: rows };
  }

  /** Restore the registry before clients are admitted and rebuild every
   * derived index. Invalid/stale ACL overlaps are normalized on the way in. */
  restoreSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.houses)) return 0;
    this.houses.clear();
    let maxId = 0;
    for (const row of snapshot.houses) {
      if (!Number.isInteger(row?.id) || row.id <= 0) continue;
      const bans = new Set((row.bans ?? []).map((v) => Number(v) >>> 0).filter(Boolean));
      const coowners = new Set((row.coowners ?? []).map((v) => Number(v) >>> 0).filter(Boolean));
      const friends = new Set((row.friends ?? []).map((v) => Number(v) >>> 0).filter(Boolean));
      for (const serial of bans) { coowners.delete(serial); friends.delete(serial); }
      const h = {
        ...row,
        id: row.id | 0, ownerSerial: row.ownerSerial >>> 0,
        map: row.map | 0, x1: row.x1 | 0, y1: row.y1 | 0, x2: row.x2 | 0, y2: row.y2 | 0, z: row.z | 0,
        coowners, friends, bans,
        lockdowns: new Set(row.lockdowns ?? []), secures: new Set(row.secures ?? []), vendors: new Set(row.vendors ?? []),
        _vendorMeta: new Map(row.vendorMeta ?? []),
        multiId: row.multiId == null ? null : row.multiId | 0,
        multiSerial: row.multiSerial == null ? null : row.multiSerial >>> 0,
        multiInstance: row.multiInstance == null ? null : row.multiInstance >>> 0,
        customizable: row.customizable === true,
        tiles: this._cloneCustomTiles(row.tiles), customTemplates: row.customTemplates ?? {},
        spawnedItems: Array.isArray(row.spawnedItems) ? row.spawnedItems.map((v) => v >>> 0) : [],
        customItemSerials: Array.isArray(row.customItemSerials) ? row.customItemSerials.map((v) => v >>> 0) : [],
        footprint: Array.isArray(row.footprint) ? row.footprint.map((cell) => [cell[0] | 0, cell[1] | 0]) : null,
        editing: null,
      };
      this.houses.set(h.id, h);
      maxId = Math.max(maxId, h.id);
    }
    this.nextHouseId = Math.max(Number(snapshot.nextHouseId) | 0, maxId + 1, 1);
    this.rebuildIndexes();
    this._lastCustomReconcile = this.reconcileCustomItems();
    return this.houses.size;
  }

  /**
   * Treat custom-house world items as derived data and repair them from the
   * authoritative committed design after a restart. A single world scan keeps
   * startup O(items + custom pieces), while signature multisets tolerate
   * duplicate graphics at one coordinate. Orphans are removed as well.
   */
  reconcileCustomItems() {
    const world = this.world;
    const stats = { checked: 0, rebuilt: 0, relinked: 0, orphansRemoved: 0, failed: 0 };
    if (!world?.items) return stats;

    const byHouse = new Map();
    const orphans = [];
    for (const item of world.items.values()) {
      if (item._customHouseId == null) continue;
      const houseId = item._customHouseId | 0;
      if (!this.houses.has(houseId)) { orphans.push(item.serial >>> 0); continue; }
      let bucket = byHouse.get(houseId);
      if (!bucket) { bucket = []; byHouse.set(houseId, bucket); }
      bucket.push(item);
    }
    for (const serial of orphans) {
      if (!world.items.has(serial)) continue;
      destroyItem(world, serial);
      if (!world.items.has(serial)) stats.orphansRemoved++;
    }

    const signatures = (entries, selector) => {
      const counts = new Map();
      for (const entry of entries) {
        const key = selector(entry);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return counts;
    };
    const sameCounts = (left, right) => left.size === right.size
      && [...left].every(([key, count]) => right.get(key) === count);

    for (const house of this.houses.values()) {
      const tiles = this._cloneCustomTiles(house.tiles);
      const actual = byHouse.get(house.id) ?? [];
      stats.checked++;
      const expectedKeys = signatures(tiles,
        (tile) => `${tile.g >>> 0}|${tile.x | 0}|${tile.y | 0}|${tile.z | 0}|${house.map | 0}`);
      const actualKeys = signatures(actual,
        (item) => `${item.itemId >>> 0}|${item.x | 0}|${item.y | 0}|${item.z | 0}|${item.map | 0}`);
      if (sameCounts(expectedKeys, actualKeys)) {
        house.customItemSerials = actual.map((item) => item.serial >>> 0);
        const bySignature = new Map();
        for (const item of actual) {
          const key = `${item.itemId >>> 0}|${item.x | 0}|${item.y | 0}|${item.z | 0}|${item.map | 0}`;
          let bucket = bySignature.get(key);
          if (!bucket) { bucket = []; bySignature.set(key, bucket); }
          bucket.push(item);
        }
        const ordered = [];
        for (const tile of tiles) {
          const key = `${tile.g >>> 0}|${tile.x | 0}|${tile.y | 0}|${tile.z | 0}|${house.map | 0}`;
          const item = bySignature.get(key)?.pop();
          if (item) ordered.push(this._configureCustomItem(item, tile, house));
        }
        this._pairCustomTeleporters(ordered.filter((item) => item?._customHouseKind === 'teleport'));
        stats.relinked += actual.length;
        continue;
      }
      house.customItemSerials = actual.map((item) => item.serial >>> 0);
      if (this._materializeCustomTiles(house, tiles) === false) stats.failed++;
      else stats.rebuilt++;
    }
    return stats;
  }

  /** Resolve a registry record from a canonical multi anchor/proxy. */
  houseByMultiInstance(instanceId) {
    if (instanceId == null) return null;
    return this.get(this._byInstance.get(instanceId >>> 0)) ?? null;
  }

  houseByMultiSerial(serial) {
    if (serial == null) return null;
    return this.get(this._bySerial.get(serial >>> 0)) ?? null;
  }

  /** Resolve the house selected by its sign/UI, with ownership enforced. */
  activeHouseFor(mob, activeHouseId = null, hintedSerial = null) {
    if (!mob) return null;
    let house = activeHouseId == null ? null : this.get(activeHouseId);
    if (!house && hintedSerial != null) house = this.houseByMultiSerial(hintedSerial);
    if (!house) house = this.housesOf(mob.serial)[0] ?? null;
    return house && this.roleOf(house, mob.serial) === 'owner' ? house : null;
  }

  /** Find the house that contains world coord (x, y) on `map`. */
  houseAt(x, y, map = 1) {
    const ids = this._bySector.get(this._sectorKey(map, x, y));
    if (!ids) return null;
    for (const id of ids) {
      const h = this.houses.get(id);
      if (!h || h.map !== map) continue;
      if (x < h.x1 || x > h.x2) continue;
      if (y < h.y1 || y > h.y2) continue;
      if (h._footprintKeys && !h._footprintKeys.has(`${x | 0}:${y | 0}`)) continue;
      return h;
    }
    return null;
  }

  /** Houses owned by the given mobile serial. */
  housesOf(serial) {
    return [...(this._byOwner.get(serial >>> 0) ?? [])]
      .map((id) => this.houses.get(id)).filter(Boolean);
  }

  /**
   * Transfer ownership of `house` to `newOwner`. Mirrors ServUO
   * `BaseHouse.SetSign` + `HouseTransferGump` confirm path: the previous
   * owner is removed from the friend list (they retain nothing), the new
   * owner is demoted from any co-owner / friend slot they may have held
   * (no duplicate ACL entries), and the touch-timestamp refreshes so the
   * decay clock resets on the deed swap.
   *
   * Returns true on success. False if `newOwner` is the current owner or
   * if `house` is already collapsed.
   */
  transferOwnership(house, newOwner) {
    if (!house || !newOwner) return false;
    const newSerial = (newOwner.serial ?? newOwner) >>> 0;
    if (house.ownerSerial === newSerial) return false;
    const oldSerial = house.ownerSerial >>> 0;
    this._unindexHouse(house);
    // An in-progress design belongs to the previous owner and must not cross
    // the ownership boundary. The committed design remains authoritative.
    house.editing = null;
    house.coowners.delete(oldSerial);
    house.friends.delete(oldSerial);
    house.bans.delete(oldSerial);
    // Clear new owner from any subordinate ACL slot.
    house.coowners.delete(newSerial);
    house.friends.delete(newSerial);
    house.bans.delete(newSerial);
    house.ownerSerial = newSerial;
    house.ownerName = newOwner.name ?? house.ownerName;
    house.lastTouchedAt = Date.now();
    this._indexHouse(house);
    this.markChanged();
    return true;
  }

  /**
   * ACL helper: 'owner' | 'coowner' | 'friend' | 'banned' | 'visitor'.
   * `null` if the mobile isn't related to the house.
   */
  roleOf(house, serial) {
    const s = serial >>> 0;
    if (house.ownerSerial === s) return 'owner';
    // A ban is an explicit deny and must win over stale subordinate roles
    // imported from older saves.
    if (house.bans.has(s)) return 'banned';
    if (house.coowners.has(s)) return 'coowner';
    if (house.friends.has(s)) return 'friend';
    return 'visitor';
  }

  canLockDown(house, mob) {
    const role = this.roleOf(house, mob.serial);
    if (role !== 'owner' && role !== 'coowner') return false;
    // ServUO BaseHouse.CheckLockdownLimit — every new lockdown checks
    // against the foundation cap. Reject if we're already at the limit
    // so the player can free space before adding more.
    const cap = house.lockdownCap ?? capsFor(house.foundation).lockdowns;
    if ((house.lockdowns?.size ?? 0) >= cap) {
      if (mob.client?.sendSystemMessage) {
        mob.client.sendSystemMessage(
          `That would exceed this house's lockdown limit (${cap}).`);
      }
      return false;
    }
    return true;
  }

  /** Returns true if the caller may move/take the lockdown'd item. */
  canMoveLockdown(house, mob, itemSerial) {
    if (!house.lockdowns.has(itemSerial >>> 0)) return true;
    const role = this.roleOf(house, mob.serial);
    return role === 'owner' || role === 'coowner';
  }

  /**
   * Cap-aware secure container check. ServUO splits secure containers
   * from lockdowns — a secure chest holds many items but consumes one
   * of the house's small secure-slot pool. Reject when at cap.
   */
  canSecure(house, mob) {
    const role = this.roleOf(house, mob.serial);
    if (role !== 'owner' && role !== 'coowner') return false;
    const cap = house.secureCap ?? capsFor(house.foundation).secures;
    if ((house.secures?.size ?? 0) >= cap) {
      if (mob.client?.sendSystemMessage) {
        mob.client.sendSystemMessage(
          `That would exceed this house's secure-container limit (${cap}).`);
      }
      return false;
    }
    return true;
  }
  addSecure(house, containerSerial) {
    house.secures ||= new Set();
    house.secures.add(containerSerial >>> 0);
    this.markChanged();
  }
  removeSecure(house, containerSerial) {
    house.secures?.delete(containerSerial >>> 0);
    this.markChanged();
  }

  // ---------- Customization (0xD7) ------------------------------------
  // Each house owns an `editing` workspace + an array of `tiles` ({g, x,
  // y, z, kind}) that compose the current committed layout. While in
  // edit mode the player mutates `editing.tiles`; backup snapshots the
  // committed list, restore copies it back, commit promotes editing to
  // committed, revert drops the editing buffer.

  beginEditing(house, mob) {
    if (!house?.customizable || this.roleOf(house, mob.serial) !== 'owner') return false;
    const editorSerial = mob.serial >>> 0;
    if (house.editing && house.editing.editorSerial !== editorSerial) return false;
    if (house.editing) {
      this.setFixturesVisibleTo(house, mob.client, false);
      return true;
    }
    house.tiles ??= [];
    house.editing = {
      tiles: this._cloneCustomTiles(house.tiles),
      backup: null,
      floor: 1,
      revision: (house.revision ?? 0) + 1,
      history: [this._cloneCustomTiles(house.tiles)],
      historyIndex: 0,
      _historyTileCount: house.tiles.length,
      clipboard: null,
      editorSerial,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      rateWindowAt: Date.now(),
      rateCount: 0,
    };
    this.setFixturesVisibleTo(house, mob.client, false);
    return true;
  }

  /** Show or hide serial-backed fixtures for one customizing connection. */
  setFixturesVisibleTo(house, client, visible) {
    if (!client || !this.world) return 0;
    let changed = 0;
    for (const serial of house?.customItemSerials ?? []) {
      const item = this.world.items.get(serial >>> 0);
      if (!item || (item._customHouseKind !== 'door' && item._customHouseKind !== 'teleport')) continue;
      try {
        if (visible) client.sendItem?.(item);
        else client.sendRemove?.(item.serial);
        changed++;
      } catch { /* disconnected editor */ }
    }
    return changed;
  }

  _cloneCustomTiles(tiles) {
    return (tiles ?? []).map((tile) => ({
      kind: String(tile.kind ?? 'item'), g: tile.g >>> 0,
      x: tile.x | 0, y: tile.y | 0, z: tile.z | 0,
    }));
  }

  _recordCustom(house) {
    const editing = house?.editing;
    if (!editing || editing._suppressHistory) return;
    editing.history ??= [this._cloneCustomTiles(editing.tiles)];
    editing.historyIndex ??= editing.history.length - 1;
    editing._historyTileCount ??= editing.history.reduce((sum, snapshot) => sum + snapshot.length, 0);
    const discarded = editing.history.splice(editing.historyIndex + 1);
    for (const snapshot of discarded) editing._historyTileCount -= snapshot.length;
    const current = this._cloneCustomTiles(editing.tiles);
    editing.history.push(current);
    editing._historyTileCount += current.length;
    // Bound both snapshot count and aggregate retained tiles. This avoids the
    // previous O(100 * design-size) memory spike under rapid editing.
    while (editing.history.length > 25
        || editing._historyTileCount > 32_768) {
      const removed = editing.history.shift();
      editing._historyTileCount -= removed?.length ?? 0;
      editing.historyIndex--;
    }
    editing.historyIndex = editing.history.length - 1;
    editing.revision = (editing.revision ?? 0) + 1;
    editing.updatedAt = Date.now();
  }

  undoCustom(house) {
    const editing = house?.editing;
    if (!editing?.history?.length || editing.historyIndex <= 0) return false;
    editing.historyIndex--;
    editing.tiles = this._cloneCustomTiles(editing.history[editing.historyIndex]);
    editing.revision = (editing.revision ?? 0) + 1;
    return true;
  }

  redoCustom(house) {
    const editing = house?.editing;
    if (!editing?.history?.length || editing.historyIndex >= editing.history.length - 1) return false;
    editing.historyIndex++;
    editing.tiles = this._cloneCustomTiles(editing.history[editing.historyIndex]);
    editing.revision = (editing.revision ?? 0) + 1;
    return true;
  }

  customHistory(house) {
    const editing = house?.editing;
    return {
      revision: editing?.revision ?? house?.revision ?? 0,
      tileCount: editing?.tiles?.length ?? house?.tiles?.length ?? 0,
      canUndo: !!editing && (editing.historyIndex ?? 0) > 0,
      canRedo: !!editing && (editing.historyIndex ?? 0) < (editing.history?.length ?? 1) - 1,
      historyLength: editing?.history?.length ?? 0,
      floor: editing?.floor ?? 1,
    };
  }

  addCustomItem(house, kind, g, x, y, z = 0) {
    if (!this._allowCustomMutation(house, 1)
        || !this._validCustomPiece(kind, g, x, y, z, house)) return false;
    house.editing.tiles.push({ kind, g: g >>> 0, x: x | 0, y: y | 0, z: z | 0 });
    this._recordCustom(house);
    return true;
  }

  removeCustomItem(house, g, x, y, z = 0) {
    if (!this._allowCustomMutation(house, 0)) return 0;
    // The web editor uses graphic 0 as "erase the topmost authored piece at
    // this tile" because a terrain pick does not necessarily carry the
    // dynamic item's graphic. Resolve that wildcard server-side.
    if ((g >>> 0) === 0) {
      const candidates = house.editing.tiles
        .map((tile, index) => ({ tile, index }))
        .filter(({ tile }) => tile.x === (x | 0) && tile.y === (y | 0));
      if (!candidates.length) return 0;
      candidates.sort((a, b) => {
        const da = Math.abs(a.tile.z - (z | 0));
        const db = Math.abs(b.tile.z - (z | 0));
        return da - db || b.tile.z - a.tile.z;
      });
      house.editing.tiles.splice(candidates[0].index, 1);
      this._recordCustom(house);
      return 1;
    }
    const before = house.editing.tiles.length;
    house.editing.tiles = house.editing.tiles.filter((t) =>
      !(t.g === (g >>> 0) && t.x === (x | 0) && t.y === (y | 0) && t.z === (z | 0)));
    const removed = before - house.editing.tiles.length;
    if (removed) this._recordCustom(house);
    return removed;
  }

  clearCustomTiles(house) {
    if (!this._allowCustomMutation(house, 0)) return;
    if (!house.editing.tiles.length) return;
    house.editing.tiles.length = 0;
    this._recordCustom(house);
  }

  backupCustom(house) {
    if (!house.editing) return false;
    house.editing.backup = this._cloneCustomTiles(house.editing.tiles);
    return true;
  }

  restoreCustom(house) {
    if (!house.editing?.backup || !this._allowCustomMutation(house, 0)) return false;
    house.editing.tiles = this._cloneCustomTiles(house.editing.backup);
    this._recordCustom(house);
    return true;
  }

  commitCustom(house) {
    if (!house.editing) return false;
    const validation = this.validateCustom(house);
    if (!validation.ok) return false;
    const nextTiles = this._cloneCustomTiles(house.editing.tiles);
    if (this._materializeCustomTiles(house, nextTiles) === false) return false;
    house.tiles = nextTiles;
    house.revision = (house.revision ?? 0) + 1;
    house.editing = null;
    this.markChanged();
    return true;
  }

  /**
   * Rebuild the visible dynamic pieces for a committed custom foundation.
   * The foundation remains a canonical multi; authored walls/floors/doors
   * are regular immovable world items so they stream, persist and collide
   * through the same authoritative world path as every other item.
   */
  _configureCustomItem(item, tile, house) {
    const kind = String(tile.kind ?? 'item');
    item.movable = false;
    // Structural components are rendered from standard 0xD8 data. Fixtures
    // remain regular visible items because they need targetable serials.
    item.visible = kind === 'door' || kind === 'teleport';
    item._customHouseId = house.id;
    item._customHouseKind = kind;
    item._noDecay = true;
    item.house = house.id;
    delete item.solid; delete item.surface; delete item.bridge; delete item.height; delete item.door;
    delete item.script; delete item._houseId; delete item._houseAclMode;
    delete item.teleportTo; delete item.pairSerial;
    if (kind === 'wall' || kind === 'roof') {
      item.solid = true;
      item.height = 20;
    } else if (kind === 'door') {
      item.door = {
        closedId: tile.g >>> 0, openId: ((tile.g >>> 0) + 1) & 0xffff,
        isOpen: false, facing: null,
      };
    } else if (kind === 'floor' || kind === 'stair') {
      item.surface = true;
      item.bridge = kind === 'stair';
      item.height = kind === 'stair' ? 10 : 0;
    } else if (kind === 'teleport') {
      item.script = 'house-teleporter';
      item._houseId = house.id;
      item._houseAclMode = 'friend';
    }
    this.world?.syncSpatialItem?.(item);
    return item;
  }

  _pairCustomTeleporters(teleporters) {
    for (let index = 0; index + 1 < teleporters.length; index += 2) {
      const a = teleporters[index], b = teleporters[index + 1];
      a.teleportTo = { x: b.x, y: b.y, z: b.z, map: b.map };
      b.teleportTo = { x: a.x, y: a.y, z: a.z, map: a.map };
      a.pairSerial = b.serial; b.pairSerial = a.serial;
      this.world?.syncSpatialItem?.(a); this.world?.syncSpatialItem?.(b);
    }
  }

  _materializeCustomTiles(house, tiles = house?.tiles ?? []) {
    const world = this.world;
    if (!house) return false;
    if (!world) return 0;
    const previousSerials = [...(house.customItemSerials ?? [])];
    const created = [];
    const teleporters = [];
    try {
      for (const tile of tiles) {
        const item = createItem(world, {
          itemId: tile.g >>> 0,
          x: tile.x | 0, y: tile.y | 0, z: tile.z | 0, map: house.map | 0,
          name: `custom house ${tile.kind ?? 'piece'}`,
          movable: false,
          visible: tile.kind === 'door' || tile.kind === 'teleport',
          _customHouseId: house.id,
          _customHouseKind: String(tile.kind ?? 'item'),
          _noDecay: true,
        });
        if (!item) throw new Error('world item factory returned no item');
        this._configureCustomItem(item, tile, house);
        if (tile.kind === 'teleport') teleporters.push(item);
        created.push(item);
      }
      this._pairCustomTeleporters(teleporters);
    } catch {
      for (const item of created) destroyItem(world, item.serial);
      return false;
    }
    // Swap only after every replacement exists. A failed build above leaves
    // the committed layout and all old serials untouched.
    for (const serial of previousSerials) {
      const old = world.items.get(serial >>> 0);
      if (!old) continue;
      for (const mob of nearbyClients(world, old)) mob.client?.sendRemove?.(old.serial);
      destroyItem(world, old.serial);
    }
    house.customItemSerials = created.map((item) => item.serial >>> 0);
    for (const item of created) {
      if (item.visible === false) continue;
      for (const mob of nearbyClients(world, item)) mob.client?.sendItem?.(item);
    }
    return house.customItemSerials.length;
  }

  revertCustom(house) {
    if (!house.editing) return false;
    house.editing = null;
    return true;
  }

  setEditingFloor(house, floor) {
    if (!house.editing) return false;
    house.editing.floor = Math.max(1, Math.min(4, floor | 0));
    return true;
  }

  // ---- Foundation paint toolkit -----------------------------------------
  // Replace the topmost tile at (x,y,z) with `g`. Used by the wall-painter
  // / floor-picker UI on the client so the player drag-and-drops one
  // piece without first manually removing the previous one. Returns the
  // count of replaced tiles (0 if nothing was at (x,y,z), 1+ if one or
  // more pieces were stacked).
  replaceTileAt(house, kind, g, x, y, z = 0) {
    if (!this._allowCustomMutation(house, 1)
        || !this._validCustomPiece(kind, g, x, y, z, house)) return 0;
    const before = house.editing.tiles.length;
    house.editing.tiles = house.editing.tiles.filter((t) =>
      !(t.x === (x | 0) && t.y === (y | 0) && t.z === (z | 0)));
    house.editing.tiles.push({ kind, g: g >>> 0, x: x | 0, y: y | 0, z: z | 0 });
    this._recordCustom(house);
    return before - house.editing.tiles.length + 1;
  }

  // Move every tile at (fromX,fromY,fromZ) to (toX,toY,toZ). The Z does
  // not change unless explicitly given. CUO `HouseCustomization` uses
  // this for "drag piece by handle". Returns count of moved tiles.
  moveTileAt(house, fromX, fromY, toX, toY, fromZ = 0, toZ = null) {
    if (!house?.editing) return 0;
    const tz = toZ === null ? fromZ : toZ;
    const candidates = house.editing.tiles.filter((tile) =>
      tile.x === (fromX | 0) && tile.y === (fromY | 0) && tile.z === (fromZ | 0));
    if (!candidates.length || candidates.some((tile) =>
      !this._validCustomPiece(tile.kind, tile.g, toX | 0, toY | 0, tz | 0, house))) return 0;
    if (!this._allowCustomMutation(house, 0)) return 0;
    let moved = 0;
    for (const t of house.editing.tiles) {
      if (t.x === (fromX | 0) && t.y === (fromY | 0) && t.z === (fromZ | 0)) {
        t.x = toX | 0; t.y = toY | 0; t.z = tz | 0;
        moved++;
      }
    }
    if (moved) this._recordCustom(house);
    return moved;
  }

  // Rotate the graphicId of every tile at (x,y,z) by 90°. CUO walls
  // come in 4-piece groups (N,E,S,W) so a 90° rotation == swap to the
  // next graphic in the group. Without `housedataLookup` we just
  // increment the id by 1 (works for default ServUO wall packs where
  // each rotation occupies the next sequential id). The optional
  // `housedataLookup(g) → groupArray` lets a client-side hook map
  // through housedata.walls/doors/floors arrays for accurate rotation.
  rotateTileAt(house, x, y, z = 0, housedataLookup = null) {
    if (!house?.editing) return 0;
    const replacements = [];
    for (const t of house.editing.tiles) {
      if (t.x !== (x | 0) || t.y !== (y | 0) || t.z !== (z | 0)) continue;
      let next = (t.g + 1) & 0xFFFF;
      if (typeof housedataLookup === 'function') {
        const group = housedataLookup(t.g);
        if (Array.isArray(group) && group.length > 0) {
          const idx = group.indexOf(t.g);
          next = idx >= 0 ? group[(idx + 1) % group.length] : group[0];
        }
      }
      if (!this._validCustomPiece(t.kind, next, t.x, t.y, t.z, house)) return 0;
      replacements.push([t, next >>> 0]);
    }
    if (!replacements.length || !this._allowCustomMutation(house, 0)) return 0;
    for (const [tile, graphic] of replacements) tile.g = graphic;
    this._recordCustom(house);
    return replacements.length;
  }

  // Bulk paint a single graphic across a rectangle of foundation tiles.
  // Replaces (not stacks) so a refurnish operation overwrites the
  // existing floor in the area. ServUO calls this from `BaseHouse.SetSign`
  // / `BaseHouse.RebuildHouse` admin paths. `kind` is 'floor' for tile
  // painters, 'wall' for the perimeter painter.
  paintRect(house, kind, g, x1, y1, x2, y2, z = 0) {
    if (!house.editing) return 0;
    const xMin = Math.min(x1, x2) | 0, xMax = Math.max(x1, x2) | 0;
    const yMin = Math.min(y1, y2) | 0, yMax = Math.max(y1, y2) | 0;
    const cells = (xMax - xMin + 1) * (yMax - yMin + 1);
    if (!this._validCustomPiece(kind, g, xMin, yMin, z, house)
        || !this._validCustomPiece(kind, g, xMax, yMax, z, house)) return 0;
    const replaced = new Set();
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) replaced.add(`${x}|${y}|${z | 0}`);
    }
    const retained = house.editing.tiles.filter((tile) => !replaced.has(`${tile.x}|${tile.y}|${tile.z}`));
    if (retained.length + cells > this._customLimit(house)
        || !this._allowCustomMutation(house, 0)) return 0;
    const additions = [];
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) additions.push({ kind, g: g >>> 0, x, y, z: z | 0 });
    }
    house.editing.tiles = [...retained, ...additions];
    this._recordCustom(house);
    return additions.length;
  }

  validateCustom(house) {
    const tiles = house?.editing?.tiles ?? house?.tiles ?? [];
    const errors = [];
    const warnings = [];
    const allowedKinds = new Set(['item', 'wall', 'door', 'floor', 'stair', 'roof', 'misc', 'teleport']);
    const seen = new Map();
    const maxTiles = this._customLimit(house);
    if (tiles.length > maxTiles) errors.push(`Tile limit exceeded (${tiles.length}/${maxTiles}).`);
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (!allowedKinds.has(String(tile.kind))) errors.push(`Tile ${i}: unsupported kind ${tile.kind}.`);
      if (!Number.isInteger(tile.g) || tile.g <= 0 || tile.g > 0xffff) errors.push(`Tile ${i}: invalid graphic.`);
      if (!this._validCustomPiece(tile.kind, tile.g, tile.x, tile.y, tile.z, house)) {
        errors.push(`Tile ${i}: graphic 0x${(tile.g >>> 0).toString(16)} is not legal for ${tile.kind}.`);
      }
      if (tile.x < house.x1 - 1 || tile.x > house.x2 + 1 || tile.y < house.y1 - 1 || tile.y > house.y2 + 1) {
        errors.push(`Tile ${i}: outside foundation (${tile.x},${tile.y}).`);
      }
      const baseZ = house?.z | 0;
      if (tile.z < baseZ - 20 || tile.z > baseZ + 100) errors.push(`Tile ${i}: invalid elevation ${tile.z}.`);
      const key = `${tile.x}|${tile.y}|${tile.z}|${tile.kind}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count === 2) warnings.push(`Overlapping ${tile.kind} tiles at ${tile.x},${tile.y},${tile.z}.`);
    }
    if (tiles.length && !tiles.some((tile) => tile.kind === 'door')) {
      warnings.push('The design has no door or explicit entrance.');
    }
    if (tiles.filter((tile) => tile.kind === 'teleport').length % 2 !== 0) {
      errors.push('Teleporters must be placed in pairs.');
    }
    const supported = new Set(tiles
      .filter((tile) => tile.kind === 'floor' || tile.kind === 'stair')
      .map((tile) => `${tile.x}|${tile.y}|${tile.z}`));
    const baseZ = (house?.z | 0) + 7;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (tile.z <= baseZ + 1 || tile.kind === 'roof') continue;
      if (!supported.has(`${tile.x}|${tile.y}|${tile.z - 20}`)) {
        warnings.push(`Tile ${i}: no direct floor support below (${tile.x},${tile.y},${tile.z}).`);
      }
    }
    return { ok: errors.length === 0, errors: errors.slice(0, 50), warnings: warnings.slice(0, 50), tileCount: tiles.length, maxTiles };
  }

  copyCustomArea(house, x1, y1, x2, y2, zMin = -20, zMax = 100) {
    if (!house?.editing) return 0;
    const minX = Math.min(x1, x2) | 0, minY = Math.min(y1, y2) | 0;
    const maxX = Math.max(x1, x2) | 0, maxY = Math.max(y1, y2) | 0;
    const selected = house.editing.tiles.filter((tile) => tile.x >= minX && tile.x <= maxX
      && tile.y >= minY && tile.y <= maxY && tile.z >= zMin && tile.z <= zMax);
    house.editing.clipboard = {
      width: maxX - minX + 1, height: maxY - minY + 1,
      tiles: selected.map((tile) => ({ ...tile, x: tile.x - minX, y: tile.y - minY })),
    };
    return selected.length;
  }

  pasteCustomArea(house, x, y, zOffset = 0, { replace = false } = {}) {
    const editing = house?.editing;
    const clip = editing?.clipboard;
    if (!clip?.tiles?.length) return 0;
    const additions = clip.tiles.map((tile) => ({
      ...tile, x: (x | 0) + tile.x, y: (y | 0) + tile.y, z: tile.z + (zOffset | 0),
    }));
    if (additions.some((tile) =>
      !this._validCustomPiece(tile.kind, tile.g, tile.x, tile.y, tile.z, house))) return 0;
    let retained = editing.tiles;
    if (replace) {
      const maxX = (x | 0) + clip.width - 1, maxY = (y | 0) + clip.height - 1;
      retained = editing.tiles.filter((tile) => tile.x < x || tile.x > maxX || tile.y < y || tile.y > maxY);
    }
    if (retained.length + additions.length > this._customLimit(house)
        || !this._allowCustomMutation(house, 0)) return 0;
    editing.tiles = [...retained, ...additions];
    this._recordCustom(house);
    return additions.length;
  }

  saveCustomTemplate(house, name, rect = null) {
    if (!house?.editing) return { ok: false, error: 'not editing' };
    const key = String(name ?? '').trim().slice(0, 40);
    if (!/^[\p{L}\p{N} _.-]{1,40}$/u.test(key)) return { ok: false, error: 'invalid template name' };
    let tiles = this._cloneCustomTiles(house.editing.tiles);
    if (rect) {
      const x1 = Math.min(rect.x1, rect.x2), x2 = Math.max(rect.x1, rect.x2);
      const y1 = Math.min(rect.y1, rect.y2), y2 = Math.max(rect.y1, rect.y2);
      tiles = tiles.filter((tile) => tile.x >= x1 && tile.x <= x2 && tile.y >= y1 && tile.y <= y2);
    }
    if (!tiles.length) return { ok: false, error: 'template is empty' };
    const minX = Math.min(...tiles.map((tile) => tile.x));
    const minY = Math.min(...tiles.map((tile) => tile.y));
    house.customTemplates ??= {};
    if (!house.customTemplates[key] && Object.keys(house.customTemplates).length >= 20) {
      return { ok: false, error: 'template limit reached' };
    }
    house.customTemplates[key] = {
      name: key, savedAt: Date.now(),
      tiles: tiles.map((tile) => ({ ...tile, x: tile.x - minX, y: tile.y - minY })),
    };
    this.markChanged();
    return { ok: true, name: key, tileCount: tiles.length };
  }

  applyCustomTemplate(house, name, x, y, zOffset = 0, options = {}) {
    const template = house?.customTemplates?.[name];
    if (!house?.editing || !template) return 0;
    house.editing.clipboard = {
      width: Math.max(...template.tiles.map((tile) => tile.x)) + 1,
      height: Math.max(...template.tiles.map((tile) => tile.y)) + 1,
      tiles: this._cloneCustomTiles(template.tiles),
    };
    return this.pasteCustomArea(house, x, y, zOffset, options);
  }
}
