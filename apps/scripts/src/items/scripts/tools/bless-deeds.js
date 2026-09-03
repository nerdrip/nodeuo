import { destroyItemBySerial } from '../../../_items.js';
import { itemBySerial } from '../../../_entities.js';
import { isInPack } from '../../../_inventory.js';
// Bless deed family — ServUO `Items/Functional/{ItemBlessDeed,ClothingBlessDeed}.cs`
// and `Items/Consumables/BlessScroll.cs`.
//
// Three single-use variants:
//   • ItemBlessDeed     → blesses any wearable/wieldable item the user
//                         targets in their backpack. Sets `_blessed`
//                         + `_blessedBy` so loot/insurance logic skips
//                         it on death.
//   • ClothingBlessDeed → same, but only `kind` starting with `clothing-`
//                         or item layer in {2..6, 19..22} (shirt/pants/etc.).
//   • BlessScroll       → identical to ItemBlessDeed but consumed via
//                         scroll-use; mainly differs in price/source
//                         (vendor SBHealer drop in OG ServUO).
//
// Each deed consumes itself on success. Bound items, newbied items, or
// items already blessed cannot be re-blessed (returns user-facing
// rejection). Operates entirely on the existing `_blessed` field
// used by `combat.killMobile` corpse-drop logic.

const CLOTHING_LAYERS = new Set([2, 3, 4, 5, 6, 19, 20, 21, 22]); // Shirt/Pants/Shoes/Cloak/Robe/etc.

function isClothing(item) {
  if (!item) return false;
  if (typeof item.layer === 'number' && CLOTHING_LAYERS.has(item.layer)) return true;
  const k = String(item.kind || '');
  return k.startsWith('clothing-') || k.startsWith('robe-') || k.endsWith('-cloak');
}

function blessTarget(api, world, user, item, deed, mode /* 'item' | 'clothing' */) {
  if (!item) {
    user.client?.sendSystemMessage?.('You must target an item in your pack.');
    return false;
  }
  if (!isInPack({ world }, item, user)) {
    user.client?.sendSystemMessage?.('That must be in your backpack.');
    return false;
  }
  if (item._blessed || item.newbied || item._cursed) {
    user.client?.sendSystemMessage?.('That item cannot be blessed.');
    return false;
  }
  if (mode === 'clothing' && !isClothing(item)) {
    user.client?.sendSystemMessage?.('This deed only works on wearable cloth.');
    return false;
  }
  item._blessed = true;
  item._blessedBy = user.serial;
  try { api.items?.invalidateProps?.(item.serial); } catch { /* */ }
  try { destroyItemBySerial(api, deed.serial); } catch { /* */ }
  user.client?.sendSystemMessage?.('The item glows briefly — it has been blessed.');
  return true;
}

function setTargetPrompt(world, user, deed, mode, api) {
  // Use the standard targeting cursor. The handler stashes mode + deed
  // serial on the user; the target callback runs `blessTarget`.
  user._blessDeedPending = { mode, deedSerial: deed.serial };
  if (api.targeting?.requestObjectTarget) {
    api.targeting.requestObjectTarget(user, (selectedSerial) => {
      if (!user._blessDeedPending || user._blessDeedPending.deedSerial !== deed.serial) return;
      const target = itemBySerial({ world }, selectedSerial);
      const stillExists = !!itemBySerial({ world }, deed.serial);
      if (!stillExists) return;
      blessTarget(api, world, user, target, deed, user._blessDeedPending.mode);
      delete user._blessDeedPending;
    });
  } else {
    user.client?.sendSystemMessage?.('Targeting unavailable; deed reserved. Try again later.');
  }
  setTimeout(() => {
    if (user._blessDeedPending?.deedSerial === deed.serial) {
      delete user._blessDeedPending;
      user.client?.sendSystemMessage?.('The blessing fades — the deed was not used in time.');
    }
  }, 30_000).unref?.();
}

export function buildItemBlessDeed(api) {
  return {
    name: 'item-bless-deed',
    servuoClasses: ['ItemBlessDeed', 'ItemBlessTarget'],
    onUse(world, item, user) {
      if (!user?.client) return true;
      user.client.sendSystemMessage?.('Target the item to bless (must be in your backpack).');
      setTargetPrompt(world, user, item, 'item', api);
      return true;
    },
  };
}

export function buildClothingBlessDeed(api) {
  return {
    name: 'clothing-bless-deed',
    servuoClasses: ['ClothingBlessDeed', 'ClothingBlessTarget'],
    onUse(world, item, user) {
      if (!user?.client) return true;
      user.client.sendSystemMessage?.('Target the clothing to bless (must be in your backpack).');
      setTargetPrompt(world, user, item, 'clothing', api);
      return true;
    },
  };
}

export function buildBlessScroll(api) {
  return {
    name: 'bless-scroll',
    servuoClasses: ['BlessScroll', 'PersonalBlessTarget'],
    onUse(world, item, user) {
      if (!user?.client) return true;
      user.client.sendSystemMessage?.('Target the item to bless permanently (must be in your backpack).');
      setTargetPrompt(world, user, item, 'item', api);
      return true;
    },
  };
}
