// House decoration / utility extras — Moving Crate, House Raffle Stone,
// Chest of Sending, Ball of Summoning. Each is a single small item
// script; they cluster here because they share helpers (backpack lookup,
// house-ACL gate, container ops).
//
// ServUO mappings:
//   Items/Houses/MovingCrate.cs          → moving-crate
//   Items/Houses/HouseRaffleStone.cs     → house-raffle-stone
//   Items/Special/ChestOfSending.cs      → chest-of-sending
//   Items/Skill Items/Magical/BallOfSummoning.cs → ball-of-summoning

import { getAclLevel, ACL_OWNER } from '../../behaviors/house-acl.js';
import { teleportToRune, checkRecallCast } from '../../../spells/rune-helpers.js';
import { destroyItemBySerial } from '../../../_items.js';
import { childrenOf, equipped, findBackpack } from '../../../_inventory.js';
import { moveItem } from '../../../_movement.js';
import { allItems, nearbyClients } from '../../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';

function findBankBox(api, mob) {
  for (const it of equipped(api, mob)) {
    if ((it.layer ?? 0) === 29) return it;
  }
  return null;
}

/* ──────────────── Moving Crate ──────────────── */
//
// When a house is downgraded / converted, all secure / lockdown / item
// contents are funnelled into a Moving Crate placed at the house sign.
// Double-clicking opens it as a normal container. The crate behaves
// like a 50-stone container with a 7-day decay timer — items not
// retrieved by the owner within 7 days are forfeit (deleted).
//
// We expose two paths:
//   • Manual: `[moving-crate fill <multi-serial>` (admin-only — used by
//     the demote-house path in `commands/placemulti.js`).
//   • Player: double-click → open container; the decay timer is
//     stamped at fill-time and the auto-sweep runs on the house decay
//     interval.

const CRATE_DECAY_DAYS = 7;

export function buildMovingCrate(api) {
  return {
    name: 'moving-crate',
    onCreate(_world, item) {
      item.movable = false;
      item._crateFilledAt = Date.now();
      item.weight = 50;
      item.container = true;
      item.capacity = item.capacity ?? 500;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      // Only the original house owner can open it (the multi serial is
      // saved on the crate at fill-time).
      const multi = item._sourceMultiSerial != null
        ? itemBySerial({ world }, item._sourceMultiSerial >>> 0)
        : null;
      if (multi && getAclLevel(multi, user.serial) < ACL_OWNER) {
        state.sendSystemMessage?.('Only the house owner may open the moving crate.');
        return true;
      }
      // Check decay.
      const ageMs = Date.now() - (item._crateFilledAt ?? Date.now());
      if (ageMs > CRATE_DECAY_DAYS * 24 * 60 * 60 * 1000) {
        state.sendSystemMessage?.('The moving crate has decayed. Its contents are lost.');
        try { destroyItemBySerial(api, item.serial); }
        catch { /* ignore */ }
        return true;
      }
      // Open as a normal container. Standard openContainer flow.
      if (api.protocol?.openContainer && api.protocol?.containerContentList) {
        try {
          state.send(api.protocol.openContainer({ serial: item.serial, gumpId: 0x3C }));
          const children = [...childrenOf({ world }, item)];
          state.send(api.protocol.containerContentList(children, item.serial));
        } catch { /* protocol shape variance — tolerate */ }
      }
      return true;
    },
  };
}

/* ──────────────── House Raffle Stone ──────────────── */
//
// A community-event stone placed on a plot of land. Players double-
// click to enter a raffle with a configurable ticket cost. On drawing
// day a random winner is granted a deed to a placed house and the
// rest get refunded. The stone tracks entries on its own state.
//
// Commands shipped with this script:
//   `[raffle status`      — show current pot + entries (any player)
//   `[raffle draw <stone>` — force-draw a winner (GM only)

const RAFFLE_TICKET_COST = 1000;

export function buildHouseRaffleStone(api) {
  return {
    name: 'house-raffle-stone',
    onCreate(_world, item) {
      item.movable = false;
      item._raffleEntries = item._raffleEntries ?? [];   // serial[]
      item._raffleTicketCost = item._raffleTicketCost ?? RAFFLE_TICKET_COST;
      item._raffleDrawAt = item._raffleDrawAt ?? Date.now() + 14 * 24 * 60 * 60 * 1000;
    },
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state) return true;
      // Already drawn?
      if (item._raffleWinner) {
        state.sendSystemMessage?.(`Raffle complete. Winner: serial ${item._raffleWinner}.`);
        return true;
      }
      // Already entered?
      if (item._raffleEntries.includes(user.serial)) {
        state.sendSystemMessage?.('You have already entered this raffle.');
        return true;
      }
      const pack = findBackpack(api, user);
      const gold = _countGoldIn(api, pack);
      const cost = item._raffleTicketCost | 0;
      if (gold < cost) {
        state.sendSystemMessage?.(`You need ${cost} gold to enter.`);
        return true;
      }
      _consumeGold(api, pack, cost);
      item._raffleEntries.push(user.serial);
      const remainingDays = Math.max(0, Math.ceil(
        (item._raffleDrawAt - Date.now()) / (24 * 60 * 60 * 1000)));
      state.sendSystemMessage?.(
        `You enter the raffle. ${item._raffleEntries.length} entrants — drawing in ${remainingDays} day(s).`,
      );
      return true;
    },
  };
}

/** Pull the raffle to a close and pick a winner. Exported so an admin
 *  `[raffle draw` command (registered by buildHouseRaffleStone wiring)
 *  can trigger early drawings. */
export function drawRaffle(stone) {
  if (!stone?._raffleEntries?.length) return null;
  const win = stone._raffleEntries[(Math.random() * stone._raffleEntries.length) | 0];
  stone._raffleWinner = win;
  stone._raffleDrawnAt = Date.now();
  return win;
}

function _countGoldIn(api, container) {
  if (!container) return 0;
  let total = 0;
  for (const it of childrenOf(api, container)) {
    if (it.itemId === 0x0EED) total += it.amount | 0;
  }
  return total;
}

function _consumeGold(api, container, amount) {
  if (!container) return false;
  let need = amount;
  for (const it of childrenOf(api, container)) {
    if (need <= 0) break;
    if (it.itemId !== 0x0EED) continue;
    const have = it.amount | 0;
    if (have <= need) {
      need -= have;
      try { destroyItemBySerial(api, it.serial); } catch { /* ignore */ }
    } else {
      it.amount = have - need;
      need = 0;
    }
  }
  return need <= 0;
}

/* ──────────────── Chest of Sending ──────────────── */
//
// Drop gold INTO the chest (or double-click while gold is selected) →
// the gold is instantly transferred to the user's bank box. Has a
// per-instance charge counter; each charge moves up to 30 000 gold
// in one hit. ServUO `ChestOfSending.cs:75` triggers on `OnDragDropInto`
// — we expose a `[send` command that targets the chest and uses one
// charge to bank all gold currently sitting inside.

export function buildChestOfSending(api) {
  function recharge(item) {
    const max = item.maxCharges ?? 50;
    if ((item.charges | 0) >= max) return;
    const now = Date.now();
    if (!item.sendingNextRechargeAt) {
      item.sendingNextRechargeAt = now + (11 + Math.floor(Math.random() * 3)) * 60 * 60 * 1000;
      return;
    }
    if (now >= item.sendingNextRechargeAt) {
      item.charges = Math.min(max, (item.charges | 0) + 1);
      item.sendingNextRechargeAt = now + (11 + Math.floor(Math.random() * 3)) * 60 * 60 * 1000;
    }
  }
  function isChildOfBackpack(world, target, user) {
    const pack = findBackpack({ world }, user);
    if (!pack) return false;
    let current = target;
    for (let guard = 0; current && guard < 32; guard++) {
      if ((current.parent >>> 0) === (pack.serial >>> 0)) return true;
      current = current.parent ? itemBySerial({ world }, current.parent >>> 0) : null;
    }
    return false;
  }
  return {
    name: 'chest-of-sending',
    onCreate(_world, item) {
      item.charges = item.charges ?? 50;
      item.maxCharges ??= 50;
      item.secureLevel ??= 'CoOwners';
      item.servuoClasses ??= ['ChestOfSending', 'UseChestEntry', 'FlipableAttribute'];
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      recharge(item);
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The chest of sending has no charges remaining.');
        return true;
      }
      if (!item.lockedDown && !item.secure && !item.isSecure && user.accessLevel !== 'GM' && user.accessLevel !== 'Admin') {
        state.sendSystemMessage?.('This must be locked down or secured in order to use it.');
        return true;
      }
      const bank = findBankBox(api, user);
      if (!bank) {
        state.sendSystemMessage?.('You have no bank box.');
        return true;
      }
      if (!api.targeting?.request) {
        state.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      state.sendSystemMessage?.('Target an item in your backpack to send to your bank.');
      api.targeting.request(state, (picked) => {
        const target = picked?.serial ? itemBySerial({ world }, picked.serial >>> 0) : null;
        if (!target) return;
        if (target.container || target.script === 'chest-of-sending' || target.script === 'bag-of-sending') {
          state.sendSystemMessage?.('You cannot send a container through the chest of sending.');
          return;
        }
        if (!isChildOfBackpack(world, target, user)) {
          state.sendSystemMessage?.('This item must be in your backpack.');
          return;
        }
        moveItem(api, target, {
          parent: bank.serial,
          x: 60 + ((Math.random() * 80) | 0),
          y: 60 + ((Math.random() * 60) | 0),
        });
        item.charges = Math.max(0, (item.charges | 0) - 1);
        state.sendSystemMessage?.(`The item was placed in your bank box. (${item.charges} charges remaining.)`);
      });
      return true;
    },
  };
}

/* ──────────────── Ball of Summoning ──────────────── */
//
// On double-click: if not yet linked to a pet, opens a target prompt
// for the user to pick one of THEIR pets. If linked, summons the pet
// to the user's tile (costing 1 charge). Greater Ball (60 charges)
// is the same flow.

export function buildBallOfSummoning(api) {
  return {
    name: 'ball-of-summoning',
    onCreate(_world, item) {
      item.charges = item.charges ?? 20;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if (!item._linkedPet) {
        // First use → link.
        state.sendSystemMessage?.('Target one of your pets to link the ball.');
        api.targeting?.request?.(state, (picked) => {
          if (!picked?.serial) return;
          const m = mobileBySerial({ world }, picked.serial >>> 0);
          if (!m) { state.sendSystemMessage?.('That is not a pet.'); return; }
          if (m.controlMaster !== user.serial) {
            state.sendSystemMessage?.('That pet does not answer to you.');
            return;
          }
          item._linkedPet = m.serial;
          item.name = `Ball of Summoning (${m.name ?? 'pet'})`;
          state.sendSystemMessage?.(`The ball binds to ${m.name ?? 'your pet'}.`);
        });
        return true;
      }
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The ball has no charges remaining.');
        return true;
      }
      const reject = checkRecallCast(api, user, state);
      if (reject) { state.sendSystemMessage?.(reject); return true; }
      const pet = mobileBySerial({ world }, item._linkedPet);
      if (!pet) {
        state.sendSystemMessage?.('The bound pet is no longer in the world.');
        return true;
      }
      const dest = { x: user.x, y: user.y, z: user.z | 0, map: user.map,
                     label: user.name ?? 'master' };
      const ok = teleportToRune(api, pet, dest);
      if (!ok) {
        state.sendSystemMessage?.('The summoning fails.');
        return true;
      }
      item.charges = Math.max(0, (item.charges | 0) - 1);
      state.sendSystemMessage?.(`${pet.name} appears beside you. (${item.charges} charges left)`);
      // Re-broadcast pet so nearby clients see the move.
      const wi = api.protocol?.worldItemSA?.({ serial: pet.serial,
        itemId: 0, hue: pet.hue, amount: 1, x: pet.x, y: pet.y, z: pet.z });
      if (wi) for (const m of nearbyClients(world, pet)) m.client.send(wi);
      return true;
    },
  };
}
