import { destroyItemBySerial } from '../../../_items.js';
import { mobileBySerial } from '../../../_entities.js';
// Pet Bonding Deed — port of ServUO `Items/Special/PetBondingDeed.cs`.
//
// Single-use consumable: on use, target one of your pets. If the pet
// is tamed by you and not already bonded, it instantly becomes bonded
// (`bonded: true`) and the deed is consumed. ServUO normally requires
// 7 in-game days of feeding for bonding to take; the deed bypasses
// that grind.

export default function buildPetBondingDeed(api) {
  return {
    name: 'pet-bonding-deed',
    servuoClasses: ['PetBondingDeed', 'PetBondingPotion', 'BondingTarget'],
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if (!api.targeting?.request) {
        state.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      state.sendSystemMessage?.('Target the pet to bond.');
      api.targeting.request(state, (picked) => {
        if (!picked?.serial) return;
        const pet = mobileBySerial({ world }, picked.serial >>> 0);
        if (!pet) { state.sendSystemMessage?.('That is not a pet.'); return; }
        if (pet.controlMaster !== user.serial) {
          state.sendSystemMessage?.('That pet does not answer to you.');
          return;
        }
        if (pet.bonded) {
          state.sendSystemMessage?.('That pet is already bonded.');
          return;
        }
        pet.bonded = true;
        pet.bondedAt = Date.now();
        try { destroyItemBySerial(api, item.serial); }
        catch { /* ignore */ }
        state.sendSystemMessage?.(
          `★ ${pet.name ?? 'Your pet'} is now bonded to you. ★`,
        );
      });
      return true;
    },
  };
}
