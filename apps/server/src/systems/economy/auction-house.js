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

import { createItem, destroyItem } from '../../world/items.js';
import { serializeItem } from '../../world/persistence.js';

const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;
const LISTING_FEE_PCT = 0.02;       // 2 % of starting bid
const GOLD_ITEM_IDS = new Set([0x0EED, 0x0EEE, 0x0EEF]);

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

function directChildren(world, parentSerial) {
  const indexed = world?._childrenByParent?.get?.(parentSerial);
  if (indexed) return Array.from(indexed, (serial) => world.items.get(serial)).filter(Boolean);
  return Array.from(world?.items?.values?.() ?? []).filter((item) => item.parent === parentSerial);
}

function resolveBackpack(world, mob) {
  if (!mob) return null;
  for (const item of directChildren(world, mob.serial)) {
    if ((item.layer | 0) === 21) return item;
  }
  return null;
}

function descendants(world, parent) {
  if (!parent) return [];
  const result = [];
  const seen = new Set([parent.serial >>> 0]);
  const stack = [parent.serial >>> 0];
  while (stack.length) {
    const serial = stack.pop();
    for (const item of directChildren(world, serial)) {
      const childSerial = item.serial >>> 0;
      if (seen.has(childSerial)) continue;
      seen.add(childSerial);
      result.push(item);
      stack.push(childSerial);
    }
  }
  return result;
}

function goldPiles(world, mob) {
  const pack = resolveBackpack(world, mob);
  if (!pack) return null;
  return descendants(world, pack).filter((item) => (
    GOLD_ITEM_IDS.has(item.itemId | 0) && (item.amount ?? 1) > 0
  ));
}

function goldBalance(world, mob) {
  const piles = goldPiles(world, mob);
  if (piles) return piles.reduce((total, pile) => total + Math.max(0, pile.amount ?? 1), 0);
  return Math.max(0, mob?.gold | 0);
}

function debitGold(world, mob, amount) {
  const debit = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!mob || goldBalance(world, mob) < debit) return false;
  const piles = goldPiles(world, mob);
  if (!piles) {
    mob.gold = Math.max(0, (mob.gold | 0) - debit);
    return true;
  }
  let remaining = debit;
  for (const pile of piles) {
    if (remaining <= 0) break;
    const have = Math.max(0, pile.amount ?? 1);
    if (have <= remaining) {
      remaining -= have;
      destroyItem(world, pile.serial);
    } else {
      pile.amount = have - remaining;
      remaining = 0;
    }
  }
  return remaining === 0;
}

function creditGold(world, mob, amount) {
  const credit = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!mob || credit <= 0) return credit === 0;
  const pack = resolveBackpack(world, mob);
  if (!pack) {
    mob.gold = (mob.gold | 0) + credit;
    return true;
  }
  try {
    createItem(world, {
      itemId: 0x0EED, amount: credit, parent: pack.serial,
      x: 60, y: 60, z: 0, map: mob.map ?? 1,
      name: 'gold coins', stackable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function deliverItem(world, lot, recipient) {
  if (!recipient || lot.itemDelivered) return lot.itemDelivered === true;
  const pack = resolveBackpack(world, recipient);
  if (!pack) return false;
  try {
    createItem(world, {
      ...lot.item,
      x: 60, y: 60, z: 0, map: recipient.map ?? 1,
      parent: pack.serial, layer: 0, gridX: 60, gridY: 60,
    });
    lot.itemDelivered = true;
    return true;
  } catch {
    return false;
  }
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
  if (buyoutPrice > 0 && buyoutPrice < startingBid) return { ok: false, reason: 'buyout-below-starting' };
  const duration = Math.max(1_000, Math.trunc(Number(opts.durationMs ?? DEFAULT_DURATION_MS)));
  const fee = Math.ceil(startingBid * LISTING_FEE_PCT);
  if (world.items?.get?.(item.serial) !== item) return { ok: false, reason: 'item-not-live' };
  if (goldBalance(world, consigner) < fee) {
    return { ok: false, reason: `listing-fee-${fee}gp` };
  }
  let snapshot;
  try {
    snapshot = serializeItem(item);
  } catch {
    return { ok: false, reason: 'item-not-serializable' };
  }
  snapshot.serialOriginal = item.serial;
  delete snapshot.serial;
  delete snapshot.parent;
  if (!debitGold(world, consigner, fee)) return { ok: false, reason: `listing-fee-${fee}gp` };
  destroyItem(world, item.serial);
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
    pendingRefunds: [],
    payoutDelivered: false,
    itemDelivered: false,
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
  const requested = Math.max(0, Math.trunc(Number(amount) || 0));
  const accepted = lot.buyoutPrice > 0 ? Math.min(requested, lot.buyoutPrice) : requested;
  if (accepted < lot.startingBid) return { ok: false, reason: 'below-starting' };
  if (accepted <= lot.currentBid) return { ok: false, reason: 'must-outbid' };

  const sameBidder = (lot.currentBidder >>> 0) === (mob.serial >>> 0);
  const debit = sameBidder ? accepted - lot.currentBid : accepted;
  if (!debitGold(world, mob, debit)) return { ok: false, reason: 'no-gold' };

  if (lot.currentBidder && !sameBidder) {
    const refund = { bidder: lot.currentBidder, amount: lot.currentBid, delivered: false };
    const prior = world.mobiles.get(lot.currentBidder);
    refund.delivered = creditGold(world, prior, refund.amount);
    lot.pendingRefunds ??= [];
    lot.pendingRefunds.push(refund);
  }
  lot.currentBid = accepted;
  lot.currentBidder = mob.serial;
  lot.currentBidderName = mob.name ?? 'unknown';
  lot.history.push({ bidder: mob.serial, amount: accepted, ts: Date.now() });
  // Buyout — instant close.
  if (lot.buyoutPrice > 0 && accepted >= lot.buyoutPrice) {
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
    lot.status = 'expired';
    const consigner = world.mobiles.get(lot.consignerSerial);
    deliverItem(world, lot, consigner);
    return { ok: true, lot, payout: 0, returnedToConsigner: lot.itemDelivered };
  }
  const consigner = world.mobiles.get(lot.consignerSerial);
  const winner = world.mobiles.get(lot.currentBidder);
  lot.status = 'sold';
  lot.payoutDelivered = creditGold(world, consigner, lot.currentBid);
  deliverItem(world, lot, winner);
  return {
    ok: true, lot, payout: lot.currentBid,
    payoutDelivered: lot.payoutDelivered, itemDelivered: lot.itemDelivered,
  };
}

/** Deliver every pending auction refund/item/payout owned by a character. */
export function reclaim(world, mob, lotId = 0) {
  if (!world || !mob) return { ok: false, reason: 'no-args' };
  const store = ensureStore(world);
  const lots = lotId ? [store.lots.get(lotId | 0)].filter(Boolean) : [...store.lots.values()];
  if (lotId && lots.length === 0) return { ok: false, reason: 'no-such-lot' };
  let items = 0;
  let gold = 0;
  for (const lot of lots) {
    for (const refund of lot.pendingRefunds ?? []) {
      if (refund.delivered || (refund.bidder >>> 0) !== (mob.serial >>> 0)) continue;
      if (creditGold(world, mob, refund.amount)) {
        refund.delivered = true;
        gold += refund.amount;
      }
    }
    if (lot.status === 'sold' && (lot.consignerSerial >>> 0) === (mob.serial >>> 0)
        && !lot.payoutDelivered && creditGold(world, mob, lot.currentBid)) {
      lot.payoutDelivered = true;
      gold += lot.currentBid;
    }
    const ownsPendingItem = !lot.itemDelivered && (
      (lot.status === 'expired' && (lot.consignerSerial >>> 0) === (mob.serial >>> 0))
      || (lot.status === 'sold' && (lot.currentBidder >>> 0) === (mob.serial >>> 0))
    );
    if (ownsPendingItem && deliverItem(world, lot, mob)) items++;
  }
  return { ok: true, items, gold };
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
