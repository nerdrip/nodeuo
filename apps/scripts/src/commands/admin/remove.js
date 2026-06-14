// FAZA HG — `[remove` GM target-and-delete.
//
// ServUO `Scripts/Commands/Remove.cs` lets staff cleanly remove any
// entity from the world. We honour the same: pick mob → kill +
// drop corpse-less; pick item → destroyItem (fires onDestroy + visibility
// removeEntity to nearby clients).

import { allMobiles } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';
import { destroyMobileBySerial } from '../../_mobiles.js';

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'remove',
    help: '[remove — target an entity to delete it from the world.',
    access: 'GM',
    run(ctx) {
      ctx.state.sendSystemMessage('Remove what?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) {
          ctx.state.sendSystemMessage('Cancelled.');
          return;
        }
        const serial = picked.serial >>> 0;
        // BUGFIX #121 (FAZA HG): the obvious `world.mobiles.delete()`
        // path would have left phantom mobs on every observer's screen
        // until they walked away (no removeEntity broadcast). Use the
        // same broadcast pattern we wired in #65/#75/#80/#84 for any
        // visibility-affecting mutation.
        const mob = mobileBySerial(api, serial);
        if (mob) {
          if (mob.client) {
            ctx.state.sendSystemMessage('Cannot remove a logged-in player.');
            return;
          }
          if (api.protocol?.removeEntity) {
            const rm = api.protocol.removeEntity(serial);
            for (const m of allMobiles(api)) {
              if (!m.client) continue;
              if (m.map !== mob.map) continue;
              if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
              m.client.send(rm);
            }
          }
          destroyMobileBySerial(api, serial);
          ctx.state.sendSystemMessage(`Removed mob: ${mob.name ?? '?'}.`);
          return;
        }
        const item = itemBySerial(api, serial);
        if (item) {
          // destroyItem already runs onDestroy hooks + visibility-gated
          // removeEntity to nearby clients (FAZA BN lifecycle).
          destroyItemBySerial(api, serial);
          if (api.protocol?.removeEntity) {
            const rm = api.protocol.removeEntity(serial);
            // Send to sender at minimum — they're standing right next to it.
            ctx.sender.client?.send(rm);
          }
          ctx.state.sendSystemMessage(`Removed item: ${item.name ?? '?'} (0x${item.itemId.toString(16)}).`);
          return;
        }
        ctx.state.sendSystemMessage('Bad target — neither mob nor item.');
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('remove');
}
