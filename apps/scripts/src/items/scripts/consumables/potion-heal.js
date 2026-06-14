// Greater / Healing potion — single use, restores 12..19 HP.
// Drinking is consumeOne() — stack-aware so a 3-pack of potions
// decrements amount by 1, a single bottle gets destroyed.
//
// 10-second drink cooldown enforced via `user._lastPotionAt`. ServUO
// `BasePotion.OnDoubleClick` checks `from.NextActionTime` (default
// ~1.5s common to actions, with potion-specific gate of ~10s on
// retail). Without it players spam-chugged potions through any DoT.

import { consumeOne } from '../_shared/consume.js';

const POTION_COOLDOWN_MS = 10_000;

export default function buildPotionHealScript(api) {
  return {
    name: 'potion-heal',
    onUse(world, item, user) {
      if (!user) return false;
      const now = Date.now();
      if ((user._lastPotionAt ?? 0) > now - POTION_COOLDOWN_MS) {
        const wait = Math.ceil((POTION_COOLDOWN_MS - (now - (user._lastPotionAt ?? 0))) / 1000);
        user.client?.sendSystemMessage?.(`You must wait ${wait}s before drinking another potion.`);
        return false;
      }
      const heal = 12 + Math.floor(Math.random() * 8);  // 12..19
      user.hp = Math.min(user.hpMax ?? 50, (user.hp ?? 0) + heal);
      user._lastPotionAt = now;
      user.client?.sendSystemMessage?.(`You drink the healing potion (+${heal} HP).`);
      if (api.protocol?.healthUpdate && user.client) {
        user.client.send(api.protocol.healthUpdate({
          serial: user.serial, current: user.hp, max: user.hpMax ?? 50,
        }));
      }
      consumeOne(api, world, item, user);
      return true;
    },
  };
}
