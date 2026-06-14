// Auction house — consign items, accept bids, auto-claim on timeout.
// Mirrors ServUO `Engines/Auction/AuctionHouse.cs` at MVP scope.
//
// Lot lifecycle:
//   1. Consigner places an item via `consign(item, opts)` → lot enters
//      OPEN state with a 24h default duration.
//   2. Buyers call `bid(lotId, mob, amount)` until duration expires or
//      reserve hits "buyout" price.
//   3. On expiry: highest bidder wins, gold transferred to consigner's
//      bank, item handed to bidder. Loser bids refund.
//   4. If no bids: item returns to consigner, no listing fee refund.
//
// Storage (in-memory + saved by world.persistence):
//   world._auctionHouse = {
//     lots: Map<lotId, Lot>,
//     nextLotId: number,
//   }

import { destroyItem } from '../../world/items.js';

const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;
const LISTING_FEE_PCT = 0.02;       // 2 % of starting bid

/** @typedef {Object} AuctionLot
 *  @property {number} id
 *  @property {object} item                // snapshot, not live ref
 *  @property {number} consignerSerial
 *  @property {string} consignerName
 *  @property {number} startingBid
 *  @property {number} buyoutPrice         // 0 = no buyout
 *  @property {number} currentBid
 *  @property {number} currentBidder       // mob serial
 *  @property {string} currentBidderName
 *  @property {number} expiresAt
 *  @property {string} status              // 'open' | 'sold' | 'expired'
 *  @property {Array<{bidder:number, amount:number, ts:number}>} history
 */

function ensureStore(world) {
  if (!world._auctionHouse) {
    world._auctionHouse = { lots: new Map(), nextLotId: 1 };
  }
  return world._auctionHouse;
}

/**
 * Consign an item. Removes the item from world (escrow) and returns
 * the lot id. Listing fee is debited from consigner's gold pile.
 */
export function consign(world, consigner, item, opts = {}) {
  if (!world || !consigner || !item) return { ok: false, reason: 'no-args' };
  const store = ensureStore(world);
  const startingBid = Math.max(1, opts.startingBid | 0);
  const buyoutPrice = Math.max(0, opts.buyoutPrice | 0);
  const duration = opts.durationMs ?? DEFAULT_DURATION_MS;
  const fee = Math.ceil(startingBid * LISTING_FEE_PCT);
  if ((consigner.gold ?? 0) < fee) {
    return { ok: false, reason: `listing-fee-${fee}gp` };
  }
  consigner.gold = (consigner.gold ?? 0) - fee;
  // Snapshot the WHOLE item — bug-hunt #7 B1: previously only itemId/hue/
  // amount/name were captured, so winners got a stripped-down "default"
  // copy of a stat-laden artifact (no durability, runic tier, exceptional,
  // crafter author, weapon affixes, slayer, etc). structuredClone takes
  // an O(payload) snapshot that survives the lot lifetime.
  let snapshot;
  try {
    snapshot = structuredClone(item);
  } catch {
    // Fallback for items that hold non-cloneable refs (Maps, functions).
    snapshot = JSON.parse(JSON.stringify(item));
  }
  snapshot.serialOriginal = item.serial;
  // Strip the live parent / world-coord fields; they'll be set on restore.
  delete snapshot.serial;
  delete snapshot.parent;
  try { destroyItem(world, item.serial); }
  catch { /* item gone already */ }
  const lot = {
    id: store.nextLotId++,
    item: snapshot,
    consignerSerial: consigner.serial,
    consignerName: consigner.name ?? 'unknown',
    startingBid, buyoutPrice,
    currentBid: 0, currentBidder: 0, currentBidderName: '',
    expiresAt: Date.now() + duration,
    status: 'open',
    history: [],
  };
  store.lots.set(lot.id, lot);
  return { ok: true, lotId: lot.id, fee };
}

/** Place a bid. Refunds previous bidder's escrow on success. */
export function bid(world, mob, lotId, amount) {
  const store = ensureStore(world);
  const lot = store.lots.get(lotId | 0);
  if (!lot) return { ok: false, reason: 'no-such-lot' };
  if (lot.status !== 'open') return { ok: false, reason: 'closed' };
  if (mob.serial === lot.consignerSerial) return { ok: false, reason: 'own-lot' };
  if (amount < lot.startingBid) return { ok: false, reason: 'below-starting' };
  if (amount <= lot.currentBid) return { ok: false, reason: 'must-outbid' };
  if ((mob.gold ?? 0) < amount) return { ok: false, reason: 'no-gold' };
  // Escrow new bid + refund prior.
  mob.gold -= amount;
  if (lot.currentBidder) {
    const prior = world.mobiles.get(lot.currentBidder);
    if (prior) prior.gold = (prior.gold ?? 0) + lot.currentBid;
  }
  lot.currentBid = amount;
  lot.currentBidder = mob.serial;
  lot.currentBidderName = mob.name ?? 'unknown';
  lot.history.push({ bidder: mob.serial, amount, ts: Date.now() });
  // Buyout — instant close.
  if (lot.buyoutPrice > 0 && amount >= lot.buyoutPrice) {
    return _settle(world, lot);
  }
  return { ok: true, lot };
}

/** Periodic sweep — settles every expired lot. Caller from main.js. */
export function tickAuctions(world) {
  const store = ensureStore(world);
  const now = Date.now();
  const settled = [];
  for (const lot of store.lots.values()) {
    if (lot.status !== 'open') continue;
    if (now < lot.expiresAt) continue;
    settled.push(_settle(world, lot));
  }
  return settled;
}

function _settle(world, lot) {
  if (lot.status !== 'open') return { ok: false, reason: 'already-settled' };
  if (!lot.currentBidder) {
    // No bids — return item to consigner via mail-stub field so the
    // consigner can `[auction reclaim` it on next login.
    lot.status = 'expired';
    return { ok: true, lot, payout: 0, returnedToConsigner: true };
  }
  const consigner = world.mobiles.get(lot.consignerSerial);
  const winner = world.mobiles.get(lot.currentBidder);
  // Pay consigner — gold-pile to their backpack so it's an actual lift-
  // able item (mob.gold scalar was decoupled; bug-hunt #7 B4). Falls
  // back to mob.gold scalar when no pack exists.
  if (consigner) {
    const consPack = _resolveBackpack(world, consigner);
    if (consPack && world.createItem) {
      world.createItem({
        itemId: 0x0EED, amount: lot.currentBid, parent: consPack.serial,
        name: 'gold coins',
      });
    } else {
      consigner.gold = (consigner.gold ?? 0) + lot.currentBid;
    }
  }
  // Hand item to winner — recreate from FULL snapshot in their pack.
  if (winner) {
    const winPack = _resolveBackpack(world, winner);
    try {
      world.createItem?.({
        ...lot.item,
        x: 0, y: 0, z: 0, map: winner.map,
        parent: winPack ? winPack.serial : winner.serial,
        layer: winPack ? 0 : (lot.item.layer ?? 0),
      });
    } catch { /* fallback — leave on lot for reclaim */ }
  }
  lot.status = 'sold';
  return { ok: true, lot, payout: lot.currentBid };
}

/** Find the layer-21 backpack of a mob via the reverse parent index. */
function _resolveBackpack(world, mob) {
  if (!mob || !world?._childrenByParent) return null;
  const idx = world._childrenByParent.get(mob.serial);
  if (!idx) return null;
  for (const s of idx) {
    const it = world.items.get(s);
    if (it?.layer === 21) return it;
  }
  return null;
}

export function listOpen(world) {
  const store = ensureStore(world);
  return [...store.lots.values()]
    .filter((l) => l.status === 'open')
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

export function lotById(world, id) {
  return ensureStore(world).lots.get(id | 0) ?? null;
}

/** Manually settle (admin or buyout path). */
export function forceSettle(world, lotId) {
  const lot = lotById(world, lotId);
  if (!lot) return { ok: false, reason: 'no-such-lot' };
  return _settle(world, lot);
}

export const AUCTION_CONST = Object.freeze({
  DEFAULT_DURATION_MS, LISTING_FEE_PCT,
});
