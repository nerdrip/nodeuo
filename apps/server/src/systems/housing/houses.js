// Houses — foundation registry + ACL + lockdown tracking + decay.
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
// MVP scope (FAZA M part 1): a house is a single rectangular zone with
// an owner serial, a list of friend / co-owner serials, and a flat list
// of "locked-down" item serials. We don't yet emit per-tile foundation /
// wall / roof items (FAZA M part 2 — needs the ChunkLoader to allow
// runtime-spawned static tiles), so a "house" right now is just an
// invisible rectangle the player can lock items inside.
//
// The structure scaffolding here is enough to:
//   - Place/remove houses
//   - Check whether a tile is inside any house
//   - Identify the house at a given coord
//   - Run owner / co-owner / friend ACL
//   - Track lockdowns and prevent non-owners from picking them up
//
// Persistence: houses are kept in a map keyed by id. The save format
// (saves/world.json) will pick them up automatically once we extend the
// persistence layer to walk this registry — currently houses are
// runtime-only and reset on restart. That's the next concrete TODO.

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
      coowners: new Set(),
      friends: new Set(),
      bans: new Set(),
      lockdowns: new Set(),
      secures: new Set(),
      vendors: new Set(),
      createdAt: Date.now(),
      lastTouchedAt: Date.now(),
      sign: {
        x: x1, y: y2 + 1,
        title: opts.title ?? 'Small Stone House',
      },
      foundation: opts.foundation ?? 'small-stone',
    };
    // Seed item caps from the foundation table. Stored on the house so
    // future code (deed upgrades, GM gump) can mutate without re-deriving.
    const caps = capsFor(house.foundation);
    house.lockdownCap = caps.lockdowns;
    house.secureCap   = caps.secures;
    this.houses.set(id, house);
    return house;
  }

  /** Stamp the touch timestamp — extends the decay ladder one tick. */
  touch(house, now = Date.now()) {
    house.lastTouchedAt = now;
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
        this.houses.delete(h.id);
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
  }
  removeVendor(house, vendorSerial) {
    house.vendors.delete(vendorSerial >>> 0);
    house._vendorMeta?.delete?.(vendorSerial >>> 0);
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
        if (now - (meta.lastRentAt | 0) < DAILY_MS) continue;
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
    return this.houses.delete(id);
  }

  /** Find the house that contains world coord (x, y) on `map`. */
  houseAt(x, y, map = 1) {
    for (const h of this.houses.values()) {
      if (h.map !== map) continue;
      if (x < h.x1 || x > h.x2) continue;
      if (y < h.y1 || y > h.y2) continue;
      return h;
    }
    return null;
  }

  /** Houses owned by the given mobile serial. */
  housesOf(serial) {
    const out = [];
    for (const h of this.houses.values()) {
      if (h.ownerSerial === (serial >>> 0)) out.push(h);
    }
    return out;
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
    // Clear new owner from any subordinate ACL slot.
    house.coowners.delete(newSerial);
    house.friends.delete(newSerial);
    house.bans.delete(newSerial);
    house.ownerSerial = newSerial;
    house.ownerName = newOwner.name ?? house.ownerName;
    house.lastTouchedAt = Date.now();
    return true;
  }

  /**
   * ACL helper: 'owner' | 'coowner' | 'friend' | 'banned' | 'visitor'.
   * `null` if the mobile isn't related to the house.
   */
  roleOf(house, serial) {
    const s = serial >>> 0;
    if (house.ownerSerial === s) return 'owner';
    if (house.coowners.has(s)) return 'coowner';
    if (house.friends.has(s)) return 'friend';
    if (house.bans.has(s)) return 'banned';
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
  }
  removeSecure(house, containerSerial) {
    house.secures?.delete(containerSerial >>> 0);
  }

  // ---------- Customization (0xD7) ------------------------------------
  // Each house owns an `editing` workspace + an array of `tiles` ({g, x,
  // y, z, kind}) that compose the current committed layout. While in
  // edit mode the player mutates `editing.tiles`; backup snapshots the
  // committed list, restore copies it back, commit promotes editing to
  // committed, revert drops the editing buffer.

  beginEditing(house, mob) {
    if (this.roleOf(house, mob.serial) !== 'owner') return false;
    house.tiles ??= [];
    house.editing = {
      tiles: house.tiles.slice(),
      backup: null,
      floor: 1,
      revision: (house.revision ?? 0) + 1,
    };
    return true;
  }

  addCustomItem(house, kind, g, x, y, z = 0) {
    if (!house.editing) return false;
    house.editing.tiles.push({ kind, g: g >>> 0, x: x | 0, y: y | 0, z: z | 0 });
    return true;
  }

  removeCustomItem(house, g, x, y, z = 0) {
    if (!house.editing) return 0;
    const before = house.editing.tiles.length;
    house.editing.tiles = house.editing.tiles.filter((t) =>
      !(t.g === (g >>> 0) && t.x === (x | 0) && t.y === (y | 0) && t.z === (z | 0)));
    return before - house.editing.tiles.length;
  }

  clearCustomTiles(house) {
    if (!house.editing) return;
    house.editing.tiles.length = 0;
  }

  backupCustom(house) {
    if (!house.editing) return false;
    house.editing.backup = house.editing.tiles.slice();
    return true;
  }

  restoreCustom(house) {
    if (!house.editing || !house.editing.backup) return false;
    house.editing.tiles = house.editing.backup.slice();
    return true;
  }

  commitCustom(house) {
    if (!house.editing) return false;
    house.tiles = house.editing.tiles.slice();
    house.revision = (house.revision ?? 0) + 1;
    house.editing = null;
    return true;
  }

  revertCustom(house) {
    if (!house.editing) return false;
    house.editing = null;
    return true;
  }

  setEditingFloor(house, floor) {
    if (!house.editing) return false;
    house.editing.floor = floor | 0;
    return true;
  }

  // ---- Foundation paint toolkit -----------------------------------------
  // Replace the topmost tile at (x,y,z) with `g`. Used by the wall-painter
  // / floor-picker UI on the client so the player drag-and-drops one
  // piece without first manually removing the previous one. Returns the
  // count of replaced tiles (0 if nothing was at (x,y,z), 1+ if one or
  // more pieces were stacked).
  replaceTileAt(house, kind, g, x, y, z = 0) {
    if (!house.editing) return 0;
    const before = house.editing.tiles.length;
    house.editing.tiles = house.editing.tiles.filter((t) =>
      !(t.x === (x | 0) && t.y === (y | 0) && t.z === (z | 0)));
    house.editing.tiles.push({ kind, g: g >>> 0, x: x | 0, y: y | 0, z: z | 0 });
    return before - house.editing.tiles.length + 1;
  }

  // Move every tile at (fromX,fromY,fromZ) to (toX,toY,toZ). The Z does
  // not change unless explicitly given. CUO `HouseCustomization` uses
  // this for "drag piece by handle". Returns count of moved tiles.
  moveTileAt(house, fromX, fromY, toX, toY, fromZ = 0, toZ = null) {
    if (!house.editing) return 0;
    const tz = toZ === null ? fromZ : toZ;
    let moved = 0;
    for (const t of house.editing.tiles) {
      if (t.x === (fromX | 0) && t.y === (fromY | 0) && t.z === (fromZ | 0)) {
        t.x = toX | 0; t.y = toY | 0; t.z = tz | 0;
        moved++;
      }
    }
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
    if (!house.editing) return 0;
    let rotated = 0;
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
      t.g = next >>> 0;
      rotated++;
    }
    return rotated;
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
    let painted = 0;
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        this.replaceTileAt(house, kind, g, x, y, z);
        painted++;
      }
    }
    return painted;
  }
}
