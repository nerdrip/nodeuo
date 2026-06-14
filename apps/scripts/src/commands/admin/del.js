// [del — delete the targeted item or NPC mobile. Refuses player mobiles
// (they should never be deletable from a GM command — that's the
// account-management path). Mirrors ServUO `RemoveCommand`.

import { resolveItemOrMobileArg } from '../_targeting-helpers.js';
import { allMobiles } from '../../_spatial.js';
import { destroyItemBySerial } from '../../_items.js';
import { destroyMobileBySerial } from '../../_mobiles.js';

export default function (api) {
  const { commands, world, protocol } = api;

  function broadcastRemove(item) {
    if (!protocol?.removeEntity) return;
    const pkt = protocol.removeEntity(item.serial);
    for (const m of allMobiles({ world })) {
      if (!m.client || m.map !== item.map) continue;
      if (Math.abs(m.x - (item.x | 0)) > 18 || Math.abs(m.y - (item.y | 0)) > 18) continue;
      m.client.send(pkt);
    }
  }

  commands.register({
    name: 'del',
    help: 'Delete the targeted item or NPC.',
    access: 'GameMaster',
    run: (ctx) => {
      resolveItemOrMobileArg(api, ctx, 0, (picked) => {
        if (!picked) return;
        if (picked.kind === 'mobile') {
          const m = picked.ref;
          if (m.isPlayer) {
            ctx.state.sendSystemMessage('Refusing to delete a player mobile. Use [account / [ban instead.');
            return;
          }
          // Drop visually + remove from world.
          if (protocol?.removeEntity) {
            const pkt = protocol.removeEntity(m.serial);
            for (const o of allMobiles({ world })) {
              if (!o.client || o.map !== m.map) continue;
              if (Math.abs(o.x - m.x) > 18 || Math.abs(o.y - m.y) > 18) continue;
              o.client.send(pkt);
            }
          }
          // BH #13 B2 — use canonical destroyMobile so guild/party/pet
          // onMobileDestroyed hooks fire + worn equipment doesn't orphan.
          destroyMobileBySerial(api, m.serial);
          ctx.state.sendSystemMessage(`Deleted mobile ${m.name ?? '?'} 0x${(m.serial >>> 0).toString(16)}.`);
          return;
        }
        const it = picked.ref;
        broadcastRemove(it);
        // BH #13 B2 — destroyItem cascades children + door/ticking index cleanup.
        destroyItemBySerial({ world }, it.serial);
        ctx.state.sendSystemMessage(`Deleted item 0x${(it.serial >>> 0).toString(16)}.`);
      });
    },
  });

  return () => commands.unregister('del');
}
