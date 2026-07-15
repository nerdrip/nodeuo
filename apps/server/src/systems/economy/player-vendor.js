import { setItemParent } from '../../world/items.js';
import { runtimeGovernor } from '../runtime-governor.js';

// Player Vendor system — players hire NPC vendors to sell their goods
// while they are offline. Mirrors ServUO `Mobiles/Vendors/PlayerVendor.cs`
// + the four vendor gumps (PlayerVendorGumps / VendorRentalGumps /
// VendorInventoryGump / ReclaimVendorGump).
//
// Browser-aware notes
// -------------------
// We avoid the in-game gump round-trip for now: the player drives the
// vendor through `[pv` admin-style commands. Every command matches a
// gump button in ServUO so a future client gump can replay them.
//
// Storage
// -------
// vendor.playerVendor = {
//   ownerSerial,
//   ownerName,
//   shopName,         // "Maxine's Wares"
//   items: Map<itemSerial, { price, description }>,
//   bankBalance,      // gold the vendor has earned
//   chargesPaid,      // days paid in advance
//   lastChargeAt,     // ms timestamp
//   placeAt,          // ms timestamp the vendor was placed
//   homeX, homeY, homeZ, homeMap,
// }
//
// Charges
// -------
// 60 gp per item per day (ServUO PV_BASE_CHARGE) deducted from
// bankBalance once per real-world hour (24× per day). When balance hits
// 0 the vendor enters a 24h "abandoned" state then is removed; the
// owner can reclaim within that window via [pv reclaim.

const PV_BASE_CHARGE_PER_ITEM_DAY = 60;
const PV_HOURLY_RATE = 1 / 24;
const ABANDON_GRACE_MS = 24 * 60 * 60 * 1000;

/** @type {Set<any>} */
const _vendors = new Set();

/**
 * Convert a town crier / banker NPC kind into a fresh player-vendor
 * mobile and bind ownership.
 *
 * @param {object} world
 * @param {object} owner
 * @param {{ shopName?: string, x?: number, y?: number, z?: number, map?: number }} opts
 * @returns {object|null} the spawned vendor mobile (or null on failure)
 */
export function placeVendor(world, owner, opts = {}) {
  if (!world?.createMobile || !owner) return null;
  const x = opts.x ?? owner.x;
  const y = opts.y ?? owner.y;
  const z = opts.z ?? owner.z;
  const map = opts.map ?? owner.map;
  const female = !!opts.female;
  const vendor = world.createMobile({
    name: opts.shopName ?? `${owner.name}'s shop`,
    body: female ? 0x191 : 0x190,
    hue: opts.hue ?? 0x83EA,
    x, y, z, map,
  });
  vendor.movable = false;
  vendor.notoriety = 1;
  vendor.playerVendor = {
    ownerSerial: owner.serial,
    ownerName: owner.name ?? 'unknown',
    shopName: opts.shopName ?? `${owner.name}'s shop`,
    items: new Map(),
    bankBalance: opts.deposit ?? 1000,
    chargesPaid: 7,
    lastChargeAt: Date.now(),
    placedAt: Date.now(),
    homeX: x, homeY: y, homeZ: z, homeMap: map,
    abandonAt: null,
    rented: !!opts.rented,
    public: opts.public !== false,
    allowedBuyers: new Set(opts.allowedBuyers ?? []),
  };
  _vendors.add(vendor);
  return vendor;
}

/** Add an item to the vendor's stock at the owner's chosen price.
 *  Bug-hunt #6 P1 #6: takes optional `world` so we can keep the
 *  reverse parent→children index consistent with setItemParent. */
export function addStock(vendor, item, price, description = '', world = null) {
  if (!vendor?.playerVendor || !item) return false;
  if ((price | 0) <= 0) return false;
  vendor.playerVendor.items.set(item.serial, {
    serial: item.serial,
    itemId: item.itemId,
    name: item.name,
    amount: item.amount ?? 1,
    price: price | 0,
    description: description.slice(0, 80),
  });
  // Reparent the item onto the vendor so other players can browse.
  if (world) setItemParent(world, item, vendor.serial);
  else       item.parent = vendor.serial;
  return true;
}

/** Remove a listed item (owner pulled it back). */
export function removeStock(vendor, itemSerial) {
  if (!vendor?.playerVendor) return false;
  return vendor.playerVendor.items.delete(itemSerial);
}

/** Buy an item from the vendor — gold is debited from the buyer's pack
 *  (caller responsible) and credited to vendor's bankBalance. */
export function buyItem(world, vendor, buyer, itemSerial) {
  const tx = runtimeGovernor.transactions.begin('vendor', {
    correlationId: `vendor:${vendor?.serial ?? 0}:${buyer?.serial ?? 0}:${Date.now().toString(36)}`,
    vendor: vendor?.serial >>> 0, buyer: buyer?.serial >>> 0, item: itemSerial >>> 0,
  });
  const fail = (reason) => { runtimeGovernor.transactions.rollback(tx, reason); return { ok: false, reason }; };
  if (!vendor?.playerVendor) return fail('no-vendor');
  if (!buyer || vendor.playerVendor.ownerSerial === buyer.serial) return fail('owner-cannot-buy');
  if ((vendor.map ?? 1) !== (buyer.map ?? 1)
      || Math.max(Math.abs((vendor.x | 0) - (buyer.x | 0)), Math.abs((vendor.y | 0) - (buyer.y | 0))) > 3) {
    return fail('out-of-range');
  }
  if (!vendor.playerVendor.public && !vendor.playerVendor.allowedBuyers?.has?.(buyer.serial)) {
    return fail('access-denied');
  }
  const entry = vendor.playerVendor.items.get(itemSerial);
  if (!entry) return fail('no-item');
  // Gold check is the caller's job (player command verifies + debits
  // the buyer's pack). We just pull the item off the vendor and credit.
  const item = world.items.get(itemSerial);
  if (!item) {
    vendor.playerVendor.items.delete(itemSerial);
    return fail('item-vanished');
  }
  vendor.playerVendor.items.delete(itemSerial);
  vendor.playerVendor.bankBalance += entry.price;
  runtimeGovernor.transactions.item(tx, item.serial, 'transfer', { vendor: vendor.serial, buyer: buyer.serial, price: entry.price });
  runtimeGovernor.transactions.commit(tx);
  // Caller will reparent the item to buyer's pack.
  return { ok: true, entry, item };
}

/** Restore a purchase whose inventory/payment commit failed. */
export function rollbackPurchase(world, vendor, result) {
  if (!vendor?.playerVendor || !result?.entry || !result?.item) return false;
  vendor.playerVendor.items.set(result.entry.serial, result.entry);
  vendor.playerVendor.bankBalance = Math.max(0, vendor.playerVendor.bankBalance - (result.entry.price | 0));
  setItemParent(world, result.item, vendor.serial);
  const tx = runtimeGovernor.transactions.begin('vendor-rollback', { vendor: vendor.serial >>> 0, item: result.item.serial >>> 0 });
  runtimeGovernor.transactions.item(tx, result.item.serial, 'restore', { parent: vendor.serial });
  runtimeGovernor.transactions.rollback(tx, 'purchase commit failed');
  return true;
}

/** Owner adds gold to the vendor's bank. */
export function deposit(vendor, amount) {
  if (!vendor?.playerVendor) return 0;
  vendor.playerVendor.bankBalance += Math.max(0, amount | 0);
  return vendor.playerVendor.bankBalance;
}

/** Owner withdraws gold (subject to vendor having enough). */
export function withdraw(vendor, amount) {
  if (!vendor?.playerVendor) return 0;
  const taken = Math.min(vendor.playerVendor.bankBalance, Math.max(0, amount | 0));
  vendor.playerVendor.bankBalance -= taken;
  return taken;
}

/**
 * Snapshot the vendor's stock as a flat list — used by the client gump
 * (PlayerVendorGump.show) so the browse panel doesn't need to walk
 * server-only Map structures.
 */
export function browseSnapshot(vendor) {
  if (!vendor?.playerVendor) return null;
  return {
    serial: vendor.serial >>> 0,
    shopName: vendor.playerVendor.shopName,
    ownerName: vendor.playerVendor.ownerName,
    bankBalance: vendor.playerVendor.bankBalance | 0,
    items: [...vendor.playerVendor.items.values()].map((e) => ({
      serial: e.serial,
      itemId: e.itemId,
      name: e.name,
      amount: e.amount ?? 1,
      price: e.price | 0,
      description: e.description ?? '',
    })),
  };
}

export function canBrowse(vendor, buyer) {
  const pv = vendor?.playerVendor;
  if (!pv || !buyer) return false;
  if (pv.ownerSerial === buyer.serial) return true;
  if ((vendor.map ?? 1) !== (buyer.map ?? 1)
      || Math.max(Math.abs((vendor.x | 0) - (buyer.x | 0)), Math.abs((vendor.y | 0) - (buyer.y | 0))) > 3) return false;
  return pv.public !== false || pv.allowedBuyers?.has?.(buyer.serial);
}

/**
 * Owner-only "pull from stock" — returns the item back to the owner's
 * pack and removes it from the vendor's listing. Mirrors ServUO
 * `PlayerVendor.OnDoubleClick` + reclaim flow per-item. Returns the
 * lifted item or null on failure.
 */
export function pullStock(world, vendor, owner, itemSerial) {
  if (!vendor?.playerVendor) return null;
  if (vendor.playerVendor.ownerSerial !== owner?.serial) return null;
  const entry = vendor.playerVendor.items.get(itemSerial);
  if (!entry) return null;
  vendor.playerVendor.items.delete(itemSerial);
  const item = world.items.get(itemSerial);
  if (item) setItemParent(world, item, owner.serial);
  return item;
}

/** Owner reclaims (removes) the vendor — return all stock + bank. */
export function reclaim(world, vendor) {
  if (!vendor?.playerVendor) return null;
  const refund = vendor.playerVendor.bankBalance;
  const items = [...vendor.playerVendor.items.values()];
  vendor.playerVendor.items.clear();
  vendor.playerVendor.bankBalance = 0;
  _vendors.delete(vendor);
  // Caller delivers `items` + `refund` to the owner's bank.
  if (typeof world?.removeMobile === 'function') {
    try { world.removeMobile(vendor.serial); }
    catch { /* ignore */ }
  }
  return { refund, items };
}

/** Periodic tick — drain charges, mark abandoned vendors, sweep
 *  expired ones. Call from main.js setInterval. */
export function tickPlayerVendors(world, dt = 1) {
  const now = Date.now();
  for (const vendor of [..._vendors]) {
    const pv = vendor.playerVendor;
    if (!pv) { _vendors.delete(vendor); continue; }
    if (pv.rented && pv.rentalExpireAt && now >= pv.rentalExpireAt) {
      const renewalPrice = pv.renewalPrice | 0;
      const durationDays = [7, 14, 21, 28][pv.rentalDurationId | 0] ?? 7;
      if (pv.landlordRenew && pv.renterRenew && (pv.bankBalance | 0) >= renewalPrice) {
        pv.bankBalance -= renewalPrice;
        pv.rentalGold = (pv.rentalGold | 0) + renewalPrice;
        pv.rentalPrice = renewalPrice;
        pv.rentalExpireAt = now + durationDays * 24 * 60 * 60_000;
      } else {
        reclaim(world, vendor);
        continue;
      }
    }
    const itemCount = pv.items.size;
    if (itemCount > 0) {
      const elapsedH = (now - pv.lastChargeAt) / (60 * 60 * 1000);
      if (elapsedH >= 1) {
        const chargePerHour = itemCount * PV_BASE_CHARGE_PER_ITEM_DAY * PV_HOURLY_RATE;
        pv.bankBalance -= chargePerHour;
        pv.lastChargeAt = now;
      }
    }
    if (pv.bankBalance <= 0 && !pv.abandonAt) {
      pv.abandonAt = now + ABANDON_GRACE_MS;
    }
    if (pv.abandonAt && now >= pv.abandonAt) {
      const refund = reclaim(world, vendor);
      // Owner-reclaim window expired → contents drop to ground around home.
      if (refund?.items?.length && world?.createItem) {
        for (const e of refund.items) {
          try {
            world.createItem({
              itemId: e.itemId, name: e.name, amount: e.amount,
              x: pv.homeX, y: pv.homeY, z: pv.homeZ, map: pv.homeMap,
            });
          } catch { /* ignore */ }
        }
      }
    }
  }
  void dt;
}

export function listVendors() { return [..._vendors]; }
export function findVendorByOwner(ownerSerial) {
  for (const v of _vendors) if (v.playerVendor?.ownerSerial === ownerSerial) return v;
  return null;
}

export function rebuildVendorIndex(world) {
  _vendors.clear();
  for (const mob of world?.mobiles?.values?.() ?? []) {
    const pv = mob.playerVendor;
    if (!pv) continue;
    if (!(pv.items instanceof Map)) {
      pv.items = new Map(Object.entries(pv.items ?? {}).map(([k, v]) => [+k, v]));
    }
    _vendors.add(mob);
  }
  return _vendors.size;
}
