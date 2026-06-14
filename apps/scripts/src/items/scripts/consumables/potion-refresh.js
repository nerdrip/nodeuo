// Refresh potion — restores stamina to full.

import { consumeOne } from '../_shared/consume.js';

export default function buildPotionRefreshScript(api) {
  return {
    name: 'potion-refresh',
    onUse(world, item, user) {
      if (!user) return false;
      const now = Date.now();
      if ((user._lastPotionAt ?? 0) > now - 10_000) {
        const wait = Math.ceil((10_000 - (now - (user._lastPotionAt ?? 0))) / 1000);
        user.client?.sendSystemMessage?.(`You must wait ${wait}s before drinking another potion.`);
        return false;
      }
      user.stam = user.stamMax ?? 50;
      user._lastPotionAt = now;
      user.client?.sendSystemMessage?.('Refreshing!');
      if (api.protocol?.staminaUpdate && user.client) {
        user.client.send(api.protocol.staminaUpdate({
          serial: user.serial, current: user.stam, max: user.stamMax ?? 50,
        }));
      }
      consumeOne(api, world, item, user);
      return true;
    },
  };
}
