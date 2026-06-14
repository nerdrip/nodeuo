import { createItem, destroyItemBySerial } from '../../../_items.js';
import { mobileBySerial } from '../../../_entities.js';
// House Transfer Deed — ServUO `Items/Deeds/HouseTransferDeed.cs`.
//
// Two-step transfer: the deed is created automatically by a house owner
// via `[house transfer` (the command produces the deed and hands it to
// the target player). The target then double-clicks the deed in their
// pack to claim ownership. The deed records:
//   • `houseId`    — the registry id of the house being transferred
//   • `fromSerial` — original owner's serial (sanity check on accept)
//   • `expiresAt`  — 7-day window; an unclaimed deed self-destructs to
//                    avoid stranded deeds when accounts go inactive.
//
// On accept: HouseRegistry.transferOwnership swaps ownerSerial; the deed
// is consumed; both parties get a system message. Refuse paths return
// the deed untouched so the bearer can hand it back.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default function buildHouseTransferDeed(api) {
  return {
    name: 'house-transfer-deed',
    onUse(world, item, user) {
      if (!user?.client) return true;
      const houseReg = api.houses;
      if (!houseReg) {
        user.client.sendSystemMessage?.('Housing system unavailable.');
        return true;
      }
      // Validate the bound house still exists.
      const house = item.houseId != null ? houseReg.houses?.get?.(item.houseId) : null;
      if (!house) {
        user.client.sendSystemMessage?.('This deed is no longer valid — the house is gone.');
        try { destroyItemBySerial(api, item.serial); } catch { /* advisory */ }
        return true;
      }
      // Window check — deed lapses after 7 days unclaimed.
      if (item.expiresAt && Date.now() > item.expiresAt) {
        user.client.sendSystemMessage?.('This deed has expired.');
        try { destroyItemBySerial(api, item.serial); } catch { /* advisory */ }
        return true;
      }
      // The current house owner cannot accept their own transfer.
      if (house.ownerSerial === (user.serial >>> 0)) {
        user.client.sendSystemMessage?.('You already own that house.');
        return true;
      }
      // The deed must be in the recipient's pack (not on the ground).
      if (item.parent !== user.serial) {
        user.client.sendSystemMessage?.('You must hold this deed in your pack.');
        return true;
      }
      // One-house-per-account guard parallels `[house place`. ServUO
      // `HouseTransferDeed.ConfirmCallback` blocks the swap when the
      // recipient already owns a house. Senior shards relax this for
      // GM; keep it strict here.
      if ((houseReg.housesOf?.(user.serial) ?? []).length > 0) {
        user.client.sendSystemMessage?.('You already own a house and may not accept another.');
        return true;
      }

      const ok = houseReg.transferOwnership(house, user);
      if (!ok) {
        user.client.sendSystemMessage?.('The transfer cannot be completed.');
        return true;
      }
      // Notify both sides. Previous-owner notification only fires if they
      // are still online (their client may be null on a cold transfer).
      user.client.sendSystemMessage?.(
        `★ You are now the owner of "${house.sign?.title ?? 'the house'}". ★`,
      );
      const prevOwner = mobileBySerial({ world }, item.fromSerial >>> 0);
      prevOwner?.client?.sendSystemMessage?.(
        `${user.name ?? 'A player'} has accepted ownership of your house.`,
      );
      try { destroyItemBySerial(api, item.serial); } catch { /* advisory */ }
      return true;
    },
  };
}

/**
 * Helper used by the `[house transfer` command to mint a deed bound to a
 * specific house + recipient and drop it in the recipient's pack.
 *
 * Returns the new item on success, or `null` if the deed could not be
 * created (recipient offline, pack full, etc.).
 */
export function mintHouseTransferDeed(api, house, fromMobile, toMobile) {
  if (!house || !fromMobile || !toMobile) return null;
  const item = createItem(api, api.world, {
    itemId: 0x14F0, // generic deed graphic
    kind: 'house-transfer-deed',
    label: `a deed to ${house.sign?.title ?? 'a house'}`,
    parent: toMobile.serial,
    houseId: house.id,
    fromSerial: fromMobile.serial >>> 0,
    expiresAt: Date.now() + SEVEN_DAYS_MS,
    script: 'house-transfer-deed',
  });
  if (!item) return null;
  toMobile.client?.sendSystemMessage?.(
    `${fromMobile.name ?? 'Someone'} has given you a deed for "${house.sign?.title ?? 'a house'}". ` +
    `Double-click it in your pack to claim ownership.`,
  );
  return item;
}
