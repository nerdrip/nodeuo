// House Refresh Stone — port of ServUO `Items/Houses/HouseRefresh.cs`.
//
// A one-stone item that, when double-clicked while standing inside a
// house, refreshes the house's `lastVisitAt` to "now" — adding 15 days
// to the decay clock without requiring the owner to log in.
//
// Sold by the Architect / housing NPC for 50 000 gp. The item is
// consumed on use. Greater Refresh Stone is the same flow but adds
// 30 days — exposed via the `_refreshDays` instance field.

import { bumpVisit } from '../../behaviors/house-acl.js';
import { destroyItemBySerial } from '../../../_items.js';
import { allItems } from '../../../_spatial.js';

export default function buildRefreshStone(api) {
  return {
    name: 'refresh-stone',
    onCreate(_world, item) {
      item._refreshDays = item._refreshDays ?? 15;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      // Find the multi the user is standing in.
      let multi = null;
      for (const it of allItems({ world })) {
        if (it._multi == null) continue;
        if (it.map !== user.map) continue;
        const minX = it.x + (it._multi.minX | 0);
        const maxX = it.x + (it._multi.maxX | 0);
        const minY = it.y + (it._multi.minY | 0);
        const maxY = it.y + (it._multi.maxY | 0);
        if (user.x >= minX && user.x <= maxX
         && user.y >= minY && user.y <= maxY) { multi = it; break; }
      }
      if (!multi) {
        state.sendSystemMessage?.('You must stand inside a house to use the refresh stone.');
        return true;
      }
      bumpVisit(multi, user.serial);
      // Bonus — bumpVisit just stamps "now"; if the deed is a greater
      // variant we further antedate `lastVisitAt` so the decay window
      // is effectively longer.
      const extraDays = Math.max(0, (item._refreshDays | 0) - 15);
      if (extraDays > 0) {
        multi._acl = multi._acl ?? {};
        const now = Date.now();
        multi._acl.lastVisitAt = now + extraDays * 24 * 60 * 60 * 1000;
      }
      try { destroyItemBySerial(api, item.serial); }
      catch { /* ignore */ }
      state.sendSystemMessage?.(
        `The house decay is refreshed (+${item._refreshDays | 0} days).`,
      );
      return true;
    },
  };
}
