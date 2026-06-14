// Magincia Bazaar — port of ServUO `Scripts/Services/Magincia Bazaar/`.
// Auctioned vendor stalls across two zones; players bid on a stall for
// a 7-day rental. The winner gets a vendor NPC + storage chest;
// rent is paid weekly from a deposit pool.

const STALL_RENT_PER_WEEK = 5_000;
const RENT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const AUCTION_PERIOD_MS = 24 * 60 * 60 * 1000;

const _stalls = new Map();   // stallId → { id, x, y, map, owner, deposit, bids[], rentExpiresAt, auctionEndsAt }

export function registerStall({ id, x, y, map }) {
  if (_stalls.has(id)) return _stalls.get(id);
  const stall = {
    id, x, y, map,
    owner: null, ownerName: null, deposit: 0, bids: [],
    rentExpiresAt: 0, auctionEndsAt: 0,
  };
  _stalls.set(id, stall);
  return stall;
}

export function listStalls() { return Array.from(_stalls.values()); }
export function stall(id) { return _stalls.get(id) ?? null; }

export function bid(stallId, mob, amount) {
  const s = _stalls.get(stallId);
  if (!s) return { ok: false, reason: 'No such stall.' };
  if (s.owner) return { ok: false, reason: 'Stall is rented.' };
  if (s.auctionEndsAt && Date.now() > s.auctionEndsAt) return { ok: false, reason: 'Auction closed.' };
  if (!s.auctionEndsAt) s.auctionEndsAt = Date.now() + AUCTION_PERIOD_MS;
  const top = s.bids.reduce((m, b) => Math.max(m, b.amount), 0);
  if (amount <= top) return { ok: false, reason: `Bid above ${top}.` };
  s.bids.push({ serial: mob.serial, name: mob.name ?? 'player', amount, ts: Date.now() });
  return { ok: true, top: amount };
}

export function settle(stallId, now = Date.now()) {
  const s = _stalls.get(stallId);
  if (!s || s.owner) return null;
  if (now < s.auctionEndsAt) return null;
  if (s.bids.length === 0) {
    s.auctionEndsAt = 0;
    return null;
  }
  const winner = s.bids.reduce((a, b) => (b.amount > a.amount ? b : a));
  s.owner = winner.serial;
  s.ownerName = winner.name;
  s.deposit = winner.amount;
  s.rentExpiresAt = now + RENT_PERIOD_MS;
  s.auctionEndsAt = 0;
  s.bids = [];
  return winner;
}

/** Snapshot all stalls for save round-trip. Returns a plain array
 *  the persistence layer can JSON-stringify. */
export function serializeStalls() {
  return Array.from(_stalls.values()).map((s) => ({
    id: s.id, x: s.x, y: s.y, map: s.map,
    owner: s.owner, ownerName: s.ownerName,
    deposit: s.deposit, bids: s.bids,
    rentExpiresAt: s.rentExpiresAt, auctionEndsAt: s.auctionEndsAt,
  }));
}

/** Restore stalls from a snapshot produced by `serializeStalls()`.
 *  Replaces the in-memory map. Safe to call multiple times — re-applies
 *  state. Bug-hunt #5 A5: previously bids/owner/deposit died on restart. */
export function deserializeStalls(arr) {
  if (!Array.isArray(arr)) return 0;
  _stalls.clear();
  for (const raw of arr) {
    if (!raw?.id) continue;
    _stalls.set(raw.id, {
      id: raw.id, x: raw.x | 0, y: raw.y | 0, map: raw.map | 0,
      owner: raw.owner ?? null, ownerName: raw.ownerName ?? null,
      deposit: raw.deposit | 0, bids: Array.isArray(raw.bids) ? raw.bids : [],
      rentExpiresAt: raw.rentExpiresAt | 0,
      auctionEndsAt: raw.auctionEndsAt | 0,
    });
  }
  return _stalls.size;
}

export function chargeRent(world, now = Date.now()) {
  let evicted = 0;
  for (const s of _stalls.values()) {
    if (!s.owner) continue;
    if (now < s.rentExpiresAt) continue;
    if (s.deposit >= STALL_RENT_PER_WEEK) {
      s.deposit -= STALL_RENT_PER_WEEK;
      s.rentExpiresAt = now + RENT_PERIOD_MS;
    } else {
      // Eviction.
      s.owner = null; s.ownerName = null; s.deposit = 0;
      s.rentExpiresAt = 0;
      evicted++;
    }
  }
  void world;
  return evicted;
}
