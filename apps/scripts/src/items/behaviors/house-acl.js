import { allItems } from '../../_spatial.js';
// House ACL — owner / co-owner / friend / stranger access tiers.
// Mirrors ServUO `BaseHouse.cs` permission system. ACL state lives on
// every tile of the multi (denormalised — duplicated across the ~140
// tiles of a small house, but each tile is just a few small fields so
// the memory cost is negligible vs the lookup-cost saving of "every
// item already knows its house").
//
// Access tiers (highest privilege first):
//   • OWNER     — full control, can demolish / transfer / customise
//   • CO_OWNER  — manage friends, lockdown, banish, but NOT demolish
//   • FRIEND    — open locked doors, use locked-down containers
//   • STRANGER  — read-only; doors auto-close, can't lockdown
//
// Lockdown cap mirrors ServUO `BaseHouse.MaxLockDowns` for a "small"
// classic house (425 items). Real shards scale by structure size;
// future work can read multi.json tile counts for tier-based caps.

export const ACL_OWNER    = 4;
export const ACL_CO_OWNER = 3;
export const ACL_FRIEND   = 2;
export const ACL_STRANGER = 1;
export const ACL_NONE     = 0;

/** Maximum lockdown count for a freshly-placed house. ServUO canon. */
export const DEFAULT_LOCKDOWN_CAP = 425;

/** Maximum days of inactivity before the house decays + auto-demolishes.
 *  ServUO uses 15 days for a fresh, owner-visited house; we keep the
 *  same window. The grace period rolls forward on every owner visit. */
export const DECAY_DAYS = 15;
export const DECAY_MS   = DECAY_DAYS * 24 * 60 * 60 * 1000;

/** Build a freshly-initialised ACL for a multi placed by `owner`. */
export function newAclFor(owner) {
  if (!owner) return null;
  return {
    owner:    { serial: owner.serial >>> 0, name: owner.name },
    coOwners: [],
    friends:  [],
    bans:     [],                          // serials banished from the lot
    isPublic: false,                       // when true, doors open for everyone
    lockedDown: [],                        // serials of items locked down
    lockdownCap: DEFAULT_LOCKDOWN_CAP,
    placedAt:  Date.now(),
    lastVisitAt: Date.now(),               // bumped each time owner enters
  };
}

/** Read the ACL from any tile of the multi. Walks `_multiAcl` and falls
 *  back to a null sentinel when the tile is from a staff-placed multi
 *  with no owner (legacy placemulti runs). */
export function getAcl(multiTile) {
  return multiTile?._multiAcl ?? null;
}

/** Resolve a mob's permission tier against a multi's ACL. Server-side
 *  GMs always read as OWNER regardless of the underlying ACL so admin
 *  inspection / [destroymulti always works. */
export function getAclLevel(mob, acl, ctxAccess = 'Player') {
  if (!mob || !acl) return ACL_NONE;
  if (ctxAccess === 'GM' || ctxAccess === 'Admin' || ctxAccess === 'Seer') {
    return ACL_OWNER;
  }
  const serial = (mob.serial >>> 0);
  if ((acl.owner?.serial >>> 0) === serial) return ACL_OWNER;
  if (acl.coOwners?.some?.((e) => (e.serial >>> 0) === serial)) return ACL_CO_OWNER;
  if (acl.friends?.some?.((e) => (e.serial >>> 0) === serial))  return ACL_FRIEND;
  if (acl.bans?.some?.((e) => (e.serial >>> 0) === serial))     return ACL_NONE;   // explicitly banished
  return ACL_STRANGER;
}

/** Add an entry to a roster (friends/coOwners) idempotently. Returns
 *  `true` if added, `false` if already on the list. */
export function addToRoster(acl, rosterName, mob) {
  if (!acl || !mob) return false;
  const roster = acl[rosterName];
  if (!Array.isArray(roster)) return false;
  const serial = mob.serial >>> 0;
  if (roster.some((e) => (e.serial >>> 0) === serial)) return false;
  roster.push({ serial, name: mob.name });
  return true;
}

/** Remove a serial from a roster. Returns `true` if removed. */
export function removeFromRoster(acl, rosterName, serial) {
  if (!acl) return false;
  const roster = acl[rosterName];
  if (!Array.isArray(roster)) return false;
  const before = roster.length;
  const s = serial >>> 0;
  for (let i = roster.length - 1; i >= 0; i--) {
    if ((roster[i].serial >>> 0) === s) roster.splice(i, 1);
  }
  return roster.length < before;
}

/** Lockdown an item — pins it in place + requires FRIEND+ to release.
 *  Mutates both the item (sets `locked = true, movable = false`) and
 *  the ACL's lockedDown serial list. Caller checks the cap first. */
export function lockdownItem(acl, item) {
  if (!acl || !item) return false;
  const s = item.serial >>> 0;
  if (acl.lockedDown.includes(s)) return false;
  if (acl.lockedDown.length >= acl.lockdownCap) return false;
  acl.lockedDown.push(s);
  item.movable = false;
  item.lockedDown = true;
  return true;
}

/** Release a previously-locked-down item. */
export function releaseItem(acl, item) {
  if (!acl || !item) return false;
  const s = item.serial >>> 0;
  const idx = acl.lockedDown.indexOf(s);
  if (idx < 0) return false;
  acl.lockedDown.splice(idx, 1);
  item.movable = true;
  item.lockedDown = false;
  return true;
}

/** Bump the owner-visit timestamp. Decay timer resets to the canonical
 *  window from this point. Call from movement / region-enter once per
 *  multi per session — no need to spam per tile. */
export function bumpVisit(acl, now = Date.now()) {
  if (!acl) return;
  acl.lastVisitAt = now;
}

/** Returns `true` if the multi has expired its decay window. */
export function hasDecayed(acl, now = Date.now()) {
  if (!acl) return false;
  return (now - (acl.lastVisitAt ?? acl.placedAt ?? 0)) > DECAY_MS;
}

/** Apply the ACL across every tile of a placed multi. Called by
 *  `placemulti` right after `stampMultiAt` so the freshly-stamped
 *  tiles all share the new ACL by reference. */
export function applyAclToTiles(world, multiId, facet, acl) {
  let n = 0;
  for (const it of allItems({ world })) {
    if ((it._multi | 0) !== (multiId | 0)) continue;
    if ((it.map ?? 1) !== facet) continue;
    it._multiAcl = acl;
    n++;
  }
  return n;
}

/** Walk every multi tile + check whether it's expired. Returns a list of
 *  `{ multiId, facet, anchorTile, acl }` for the caller to demolish. */
export function findDecayedMultis(world, now = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const it of allItems({ world })) {
    const acl = it._multiAcl;
    if (!acl) continue;
    const key = `${it.map ?? 1}:${it._multi | 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hasDecayed(acl, now)) {
      out.push({ multiId: it._multi | 0, facet: it.map ?? 1, anchorTile: it, acl });
    }
  }
  return out;
}
