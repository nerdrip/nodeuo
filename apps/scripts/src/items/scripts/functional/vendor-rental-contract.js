// Vendor Rental Contract — ServUO `VendorRentalContract`,
// `VendorRentalDuration`, `RentedVendor`, `VendorRental*Gump`.
//
// Browser/Node adaptation:
//   - the contract item carries the persistent rental settings;
//   - double-click places the contract in an owned public house via cursor;
//   - `[rentcontract ...]` mirrors the contract gump buttons;
//   - `[rentedvendor ...]` mirrors the renter/landlord context menu.

import { getAclLevel, ACL_OWNER, lockdownItem, releaseItem } from '../../behaviors/house-acl.js';
import { allItems } from '../../../_spatial.js';
import { childrenOf, findBackpack, isInPack } from '../../../_inventory.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import { moveItem } from '../../../_movement.js';
import { createItem, destroyItemBySerial } from '../../../_items.js';

export const VendorRentalDuration = Object.freeze([
  { id: 0, days: 7,  label: '1 Week',  cliloc: 1062361 },
  { id: 1, days: 14, label: '2 Weeks', cliloc: 1062362 },
  { id: 2, days: 21, label: '3 Weeks', cliloc: 1062363 },
  { id: 3, days: 28, label: '1 Month', cliloc: 1062364 },
]);

const OFFER_MS = 30_000;
const MAX_RENTAL_PRICE = 5_000_000;

function durationById(id) {
  return VendorRentalDuration.find((d) => d.id === (id | 0)) ?? VendorRentalDuration[0];
}

function normaliseDuration(arg) {
  const raw = String(arg ?? '').trim().toLowerCase();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n)) {
    if (n >= 0 && n < VendorRentalDuration.length) return durationById(n);
    return VendorRentalDuration.find((d) => d.days === n) ?? null;
  }
  if (raw.includes('month')) return durationById(3);
  if (raw.includes('3')) return durationById(2);
  if (raw.includes('2')) return durationById(1);
  if (raw.includes('week')) return durationById(0);
  return null;
}

function clampPrice(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_RENTAL_PRICE, n | 0);
}

function distance(a, b) {
  if (!a || !b || (a.map ?? 1) !== (b.map ?? 1)) return Infinity;
  return Math.max(Math.abs((a.x | 0) - (b.x | 0)), Math.abs((a.y | 0) - (b.y | 0)));
}

function findHouseTileAt(world, x, y, map = 1) {
  const groups = new Map();
  for (const it of allItems({ world })) {
    if (!it?._multiAcl || it._multi == null || (it.map ?? 1) !== (map | 0)) continue;
    const key = `${it.map ?? 1}:${it._multi}`;
    let g = groups.get(key);
    if (!g) {
      g = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, tile: it };
      groups.set(key, g);
    }
    g.minX = Math.min(g.minX, it.x | 0);
    g.maxX = Math.max(g.maxX, it.x | 0);
    g.minY = Math.min(g.minY, it.y | 0);
    g.maxY = Math.max(g.maxY, it.y | 0);
  }
  const tx = x | 0;
  const ty = y | 0;
  for (const g of groups.values()) {
    if (tx >= g.minX && tx <= g.maxX && ty >= g.minY && ty <= g.maxY) return g.tile;
  }
  return null;
}

function findContractHouse(world, contract) {
  const serial = contract?.rentalHouseSerial >>> 0;
  if (serial) {
    const tile = itemBySerial({ world }, serial);
    if (tile?._multiAcl) return tile;
  }
  return findHouseTileAt(world, contract?.x ?? 0, contract?.y ?? 0, contract?.map ?? 1);
}

function isLandlord(world, contract, mob) {
  if (!contract || !mob) return false;
  if ((contract.rentalLandlordSerial >>> 0) === (mob.serial >>> 0)) return true;
  const house = findContractHouse(world, contract);
  return getAclLevel(mob, house?._multiAcl) >= ACL_OWNER;
}

function canUseContract(api, contract, mob, opts = {}) {
  const state = mob?.client;
  if (!contract || !mob) return false;
  if (opts.noOfferee && contract.rentalOffereeSerial) {
    state?.sendSystemMessage?.('That rental contract is currently being offered.');
    return false;
  }
  if (opts.backpack && isInPack(api, contract, mob)) return true;
  if (opts.landlord && isLandlord(api.world, contract, mob) && distance(contract, mob) <= 5) return true;
  if (opts.silent) return false;
  state?.sendSystemMessage?.('You cannot use that rental contract from here.');
  return false;
}

function describeContract(contract) {
  const duration = durationById(contract.rentalDurationId ?? 0);
  return [
    `duration=${duration.label}`,
    `price=${contract.rentalPrice ?? 1500}gp`,
    `landlordRenew=${contract.rentalLandlordRenew ? 'yes' : 'no'}`,
    contract.rentalOffereeSerial ? `offeredTo=0x${(contract.rentalOffereeSerial >>> 0).toString(16)}` : null,
  ].filter(Boolean).join(', ');
}

function countGoldIn(api, containerOrMob) {
  if (!containerOrMob) return 0;
  let total = 0;
  for (const it of childrenOf(api, containerOrMob)) {
    if ((it.itemId | 0) === 0x0EED) total += it.amount | 0;
  }
  return total;
}

function consumeGold(api, mob, amount) {
  let need = amount | 0;
  if (need <= 0) return true;
  const roots = [findBackpack(api, mob), mob].filter(Boolean);
  for (const root of roots) {
    for (const it of [...childrenOf(api, root)]) {
      if (need <= 0) break;
      if ((it.itemId | 0) !== 0x0EED) continue;
      const have = it.amount | 0;
      if (have <= need) {
        need -= have;
        try { destroyItemBySerial(api, it.serial); } catch { /* gone */ }
      } else {
        it.amount = have - need;
        need = 0;
      }
    }
  }
  return need <= 0;
}

function giveGold(api, mob, amount) {
  const n = amount | 0;
  if (n <= 0 || !mob) return null;
  const pack = findBackpack(api, mob);
  return createItem(api, api.world, {
    itemId: 0x0EED,
    name: 'gold',
    amount: n,
    parent: pack?.serial ?? mob.serial,
    x: 60 + ((Math.random() * 80) | 0),
    y: 60 + ((Math.random() * 60) | 0),
    z: 0,
    map: mob.map ?? 1,
  });
}

function placeContractAt(api, contract, landlord, picked) {
  const x = picked?.x ?? landlord.x;
  const y = picked?.y ?? landlord.y;
  const z = picked?.z ?? landlord.z ?? 0;
  const map = picked?.map ?? landlord.map ?? 1;
  const house = findHouseTileAt(api.world, x, y, map);
  if (!house?._multiAcl || getAclLevel(landlord, house._multiAcl) < ACL_OWNER) {
    landlord.client?.sendSystemMessage?.('The location must be inside a house that you own.');
    return false;
  }
  if (!house._multiAcl.isPublic) {
    landlord.client?.sendSystemMessage?.('Rental contracts can only be placed in public houses.');
    return false;
  }
  if (house._multiAcl.lockedDown.length >= house._multiAcl.lockdownCap) {
    landlord.client?.sendSystemMessage?.('You do not have enough lockdown storage available.');
    return false;
  }
  if ([...allItems({ world: api.world })].some((it) => (
    it !== contract
    && (it.map ?? 1) === (map | 0)
    && (it.x | 0) === (x | 0)
    && (it.y | 0) === (y | 0)
    && (it.script === 'vendor-rental-contract' || it.playerVendor)
  ))) {
    landlord.client?.sendSystemMessage?.('That location is already occupied by a vendor contract.');
    return false;
  }
  moveItem(api, contract, { parent: null, x, y, z, map });
  contract.rentalLandlordSerial = landlord.serial >>> 0;
  contract.ownerSerial = landlord.serial >>> 0;
  contract.rentalHouseSerial = house.serial >>> 0;
  contract.movable = false;
  contract.lockedDown = true;
  lockdownItem(house._multiAcl, contract);
  landlord.client?.sendSystemMessage?.('Vendor rental contract placed and locked down.');
  return true;
}

function offerContract(api, contract, landlord, offeree) {
  if (!canUseContract(api, contract, landlord, { landlord: true, noOfferee: true })) return false;
  if (!offeree?.client || offeree === landlord || offeree.ghost || offeree.dead) {
    landlord.client?.sendSystemMessage?.('That is not a valid target for a rental contract.');
    return false;
  }
  if (distance(contract, offeree) > 5) {
    landlord.client?.sendSystemMessage?.('Target is too far away.');
    return false;
  }
  contract.rentalOffereeSerial = offeree.serial >>> 0;
  contract.rentalOfferExpiresAt = Date.now() + OFFER_MS;
  contract.rentalLandlordSerial = landlord.serial >>> 0;
  contract.hasTick = true;
  landlord.client?.sendSystemMessage?.('Please wait while that person considers your offer.');
  offeree.client?.sendSystemMessage?.(
    `${landlord.name ?? 'Someone'} is offering you a vendor rental. Type [rentcontract accept 0x${(contract.serial >>> 0).toString(16)} within 30 seconds.`,
  );
  return true;
}

function acceptOffer(api, contract, renter) {
  const now = Date.now();
  if (!contract || (contract.rentalOffereeSerial >>> 0) !== (renter.serial >>> 0)) {
    renter.client?.sendSystemMessage?.('You have no pending offer on that contract.');
    return false;
  }
  if ((contract.rentalOfferExpiresAt ?? 0) <= now) {
    contract.rentalOffereeSerial = 0;
    contract.rentalOfferExpiresAt = 0;
    renter.client?.sendSystemMessage?.('That rental offer has expired.');
    return false;
  }
  const landlord = mobileBySerial(api, contract.rentalLandlordSerial >>> 0);
  if (!landlord || !isLandlord(api.world, contract, landlord)) {
    renter.client?.sendSystemMessage?.('The landlord is no longer available.');
    return false;
  }
  const price = contract.rentalPrice | 0;
  if (price > 0 && countGoldIn(api, findBackpack(api, renter) ?? renter) < price) {
    renter.client?.sendSystemMessage?.('You do not have enough gold to cover the rental contract.');
    landlord.client?.sendSystemMessage?.(`${renter.name ?? 'The renter'} declined your vendor rental offer.`);
    contract.rentalOffereeSerial = 0;
    contract.rentalOfferExpiresAt = 0;
    return false;
  }
  if (price > 0) consumeGold(api, renter, price);

  const PV = api.systems?.playerVendor;
  const duration = durationById(contract.rentalDurationId ?? 0);
  const vendor = PV?.placeVendor?.(api.world, renter, {
    shopName: `${renter.name ?? 'Renter'}'s Vendor`,
    x: contract.x, y: contract.y, z: contract.z, map: contract.map,
    deposit: 0,
    rented: true,
  });
  if (!vendor?.playerVendor) {
    renter.client?.sendSystemMessage?.('Could not place the rented vendor.');
    return false;
  }
  vendor.servuoClass = 'RentedVendor';
  vendor.servuoClasses = [
    'RentedVendor', 'VendorRentalDuration', 'ContractOptionsEntry',
    'CollectRentEntry', 'RefundOfferPrompt', 'RentalExpireTimer',
  ];
  Object.assign(vendor.playerVendor, {
    rented: true,
    rentalDurationId: duration.id,
    rentalPrice: price,
    renewalPrice: price,
    landlordRenew: !!contract.rentalLandlordRenew,
    renterRenew: false,
    rentalGold: price,
    rentalExpireAt: now + duration.days * 24 * 60 * 60_000,
    landlordSerial: landlord.serial >>> 0,
    landlordName: landlord.name ?? 'landlord',
    houseSerial: contract.rentalHouseSerial >>> 0,
  });
  try {
    const house = findContractHouse(api.world, contract);
    if (house?._multiAcl) releaseItem(house._multiAcl, contract);
    destroyItemBySerial(api, contract.serial);
  } catch { /* consumed */ }
  renter.client?.sendSystemMessage?.('You accept the rental offer and now own a vendor in this house.');
  landlord.client?.sendSystemMessage?.(`${renter.name ?? 'The renter'} accepted your vendor rental offer.`);
  return true;
}

function rentalSummary(vendor) {
  const pv = vendor?.playerVendor;
  if (!pv?.rented) return 'Not a rented vendor.';
  const duration = durationById(pv.rentalDurationId ?? 0);
  const leftMs = Math.max(0, (pv.rentalExpireAt ?? 0) - Date.now());
  const days = Math.floor(leftMs / 86_400_000);
  const hours = Math.floor((leftMs % 86_400_000) / 3_600_000);
  const renew = pv.landlordRenew && pv.renterRenew ? 'will renew' : 'will not renew';
  return `${duration.label}, expires in ${days}d ${hours}h, price=${pv.rentalPrice | 0}gp, renewal=${pv.renewalPrice | 0}gp, ${renew}.`;
}

function registerRentalCommands(api) {
  const register = api.lifecycle?.command?.bind(api.lifecycle) ?? api.commands?.register?.bind(api.commands);
  if (!register || !api.commands) return;

  register({
    name: 'rentcontract',
    help: '[rentcontract info|duration|price|renew|offer|accept|decline|place',
    access: 'Player',
    run(ctx, args) {
      const sender = ctx.sender;
      const sub = String(args?.[0] ?? '').toLowerCase();
      const parseContract = (idx = 1) => {
        const serial = (/^0x/i.test(args[idx] ?? '') ? parseInt(args[idx], 16) : parseInt(args[idx], 10)) >>> 0;
        return serial ? itemBySerial(api, serial) : null;
      };
      switch (sub) {
        case 'info': {
          const c = parseContract();
          if (!c?.script?.includes?.('vendor-rental-contract')) {
            ctx.state.sendSystemMessage?.('Usage: [rentcontract info <contract>');
            return;
          }
          ctx.state.sendSystemMessage?.(`Vendor Rental Contract: ${describeContract(c)}`);
          return;
        }
        case 'duration': {
          const c = parseContract();
          const d = normaliseDuration(args?.[2]);
          if (!c || !d || !canUseContract(api, c, sender, { backpack: true, landlord: true, noOfferee: true })) {
            ctx.state.sendSystemMessage?.('Usage: [rentcontract duration <contract> <0|1|2|3|7|14|21|28>');
            return;
          }
          c.rentalDurationId = d.id;
          ctx.state.sendSystemMessage?.(`Rental duration set to ${d.label}.`);
          return;
        }
        case 'price': {
          const c = parseContract();
          if (!c || !canUseContract(api, c, sender, { backpack: true, landlord: true, noOfferee: true })) {
            ctx.state.sendSystemMessage?.('Usage: [rentcontract price <contract> <gold>');
            return;
          }
          c.rentalPrice = clampPrice(args?.[2]);
          ctx.state.sendSystemMessage?.(`Rental price set to ${c.rentalPrice}gp.`);
          return;
        }
        case 'renew': {
          const c = parseContract();
          if (!c || !canUseContract(api, c, sender, { backpack: true, landlord: true, noOfferee: true })) {
            ctx.state.sendSystemMessage?.('Usage: [rentcontract renew <contract>');
            return;
          }
          c.rentalLandlordRenew = !c.rentalLandlordRenew;
          ctx.state.sendSystemMessage?.(`Landlord renew is now ${c.rentalLandlordRenew ? 'enabled' : 'disabled'}.`);
          return;
        }
        case 'place': {
          const c = parseContract();
          if (!c || !isInPack(api, c, sender)) {
            ctx.state.sendSystemMessage?.('Usage: [rentcontract place <contract>');
            return;
          }
          ctx.state.sendSystemMessage?.('Target the exact location you wish to rent out.');
          api.targeting?.request?.(ctx.state, (picked) => {
            if (!picked) {
              ctx.state.sendSystemMessage?.('You decide not to place the contract at this time.');
              return;
            }
            placeContractAt(api, c, sender, picked);
          }, { kind: 1 });
          return;
        }
        case 'offer': {
          const c = parseContract();
          if (!c) { ctx.state.sendSystemMessage?.('Usage: [rentcontract offer <contract> <player>'); return; }
          const serial = (/^0x/i.test(args[2] ?? '') ? parseInt(args[2], 16) : parseInt(args[2], 10)) >>> 0;
          if (serial) {
            offerContract(api, c, sender, mobileBySerial(api, serial));
            return;
          }
          ctx.state.sendSystemMessage?.('Target the person you wish to offer this contract to.');
          api.targeting?.request?.(ctx.state, (picked) => {
            if (!picked?.serial) {
              ctx.state.sendSystemMessage?.('You decide against offering the contract.');
              return;
            }
            offerContract(api, c, sender, mobileBySerial(api, picked.serial >>> 0));
          });
          return;
        }
        case 'accept': {
          const c = parseContract();
          if (!c) { ctx.state.sendSystemMessage?.('Usage: [rentcontract accept <contract>'); return; }
          acceptOffer(api, c, sender);
          return;
        }
        case 'decline': {
          const c = parseContract();
          if (!c || (c.rentalOffereeSerial >>> 0) !== (sender.serial >>> 0)) {
            ctx.state.sendSystemMessage?.('You have no pending offer on that contract.');
            return;
          }
          const landlord = mobileBySerial(api, c.rentalLandlordSerial >>> 0);
          c.rentalOffereeSerial = 0;
          c.rentalOfferExpiresAt = 0;
          ctx.state.sendSystemMessage?.('You decline the vendor rental offer.');
          landlord?.client?.sendSystemMessage?.(`${sender.name ?? 'The renter'} declined your vendor rental offer.`);
          return;
        }
        default:
          ctx.state.sendSystemMessage?.('Usage: [rentcontract info|duration|price|renew|place|offer|accept|decline');
      }
    },
  });

  register({
    name: 'rentedvendor',
    help: '[rentedvendor info|renew|price|collect|terminate',
    access: 'Player',
    run(ctx, args) {
      const sender = ctx.sender;
      const sub = String(args?.[0] ?? '').toLowerCase();
      const serial = (/^0x/i.test(args[1] ?? '') ? parseInt(args[1], 16) : parseInt(args[1], 10)) >>> 0;
      const vendor = serial ? mobileBySerial(api, serial) : api.systems?.playerVendor?.findVendorByOwner?.(sender.serial);
      const pv = vendor?.playerVendor;
      if (!pv?.rented) {
        ctx.state.sendSystemMessage?.('That is not a rented vendor.');
        return;
      }
      const isOwner = (pv.ownerSerial >>> 0) === (sender.serial >>> 0);
      const isOwnerAccount = isOwner;
      const isLandlordMob = (pv.landlordSerial >>> 0) === (sender.serial >>> 0);
      switch (sub) {
        case 'info':
          ctx.state.sendSystemMessage?.(rentalSummary(vendor));
          return;
        case 'renew':
          if (!isOwnerAccount && !isLandlordMob) { ctx.state.sendSystemMessage?.('You cannot change this contract.'); return; }
          if (isOwnerAccount) pv.renterRenew = !pv.renterRenew;
          else pv.landlordRenew = !pv.landlordRenew;
          ctx.state.sendSystemMessage?.(rentalSummary(vendor));
          return;
        case 'price':
          if (!isLandlordMob) { ctx.state.sendSystemMessage?.('Only the landlord may set the renewal price.'); return; }
          pv.renewalPrice = clampPrice(args?.[2]);
          pv.renterRenew = false;
          ctx.state.sendSystemMessage?.(`Renewal price set to ${pv.renewalPrice}gp. Renter renewal reset.`);
          return;
        case 'collect': {
          if (!isLandlordMob) { ctx.state.sendSystemMessage?.('Only the landlord may collect rent.'); return; }
          const amount = pv.rentalGold | 0;
          if (amount <= 0) { ctx.state.sendSystemMessage?.('There is no rent to collect.'); return; }
          giveGold(api, sender, amount);
          pv.rentalGold = 0;
          ctx.state.sendSystemMessage?.(`Collected ${amount}gp in rent.`);
          return;
        }
        case 'terminate': {
          if (!isLandlordMob) { ctx.state.sendSystemMessage?.('Only the landlord may terminate this rented vendor.'); return; }
          api.systems?.playerVendor?.reclaim?.(api.world, vendor);
          ctx.state.sendSystemMessage?.('Rental contract terminated. The vendor was dismissed.');
          return;
        }
        default:
          ctx.state.sendSystemMessage?.('Usage: [rentedvendor info|renew|price|collect|terminate <vendor>');
      }
    },
  });
}

export default function buildVendorRentalContract(api) {
  registerRentalCommands(api);
  return {
    name: 'vendor-rental-contract',
    hasTick: true,
    onCreate(_world, item) {
      item.itemId ||= 0x14F0;
      item.hue ||= 0x672;
      item.name ||= 'a vendor rental contract';
      item.weight ??= 1;
      item.rentalDurationId ??= 0;
      item.rentalPrice ??= 1500;
      item.rentalLandlordRenew ??= false;
      item.rentalOffereeSerial ??= 0;
      item.rentalOfferExpiresAt ??= 0;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if (item.rentalOffereeSerial) {
        state.sendSystemMessage?.('That item is currently in use.');
        return true;
      }
      if (isInPack({ ...api, world }, item, user)) {
        state.sendSystemMessage?.(`Vendor Rental Contract: ${describeContract(item)}`);
        state.sendSystemMessage?.(`Use [rentcontract duration/price/renew 0x${(item.serial >>> 0).toString(16)} to configure, or [rentcontract place 0x${(item.serial >>> 0).toString(16)} to place it.`);
        return true;
      }
      if (isLandlord(world, item, user)) {
        state.sendSystemMessage?.(`Vendor Rental Contract: ${describeContract(item)}`);
        state.sendSystemMessage?.(`Use [rentcontract offer 0x${(item.serial >>> 0).toString(16)} to offer it to a player.`);
        return true;
      }
      state.sendSystemMessage?.('You see nothing useful about that rental contract.');
      return true;
    },
    onTick(_world, item) {
      if (!item.rentalOffereeSerial || !item.rentalOfferExpiresAt) return;
      if (Date.now() < item.rentalOfferExpiresAt) return;
      const offeree = mobileBySerial(api, item.rentalOffereeSerial >>> 0);
      offeree?.client?.sendSystemMessage?.('The vendor rental offer has expired.');
      item.rentalOffereeSerial = 0;
      item.rentalOfferExpiresAt = 0;
    },
    onDestroy(world, item) {
      const house = findContractHouse(world, item);
      if (house?._multiAcl) releaseItem(house._multiAcl, item);
    },
  };
}
