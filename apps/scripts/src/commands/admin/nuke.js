// `[nuke [radius]` — destroy all items within `radius` tiles (default 3).
// Inspired by ServUO's various admin cleanup commands. Admin only.

import { allItems, nearbyClients } from '../../_spatial.js';
import { destroyItemBySerial } from '../../_items.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  api.commands.register({
    name: 'nuke',
    help: 'nuke [radius] — remove nearby ground items (admin)',
    run(ctx, args) {
      if (ctx.state.account && ctx.state.account.accessLevel !== 'Admin') {
        ctx.state.sendSystemMessage('Admin only.');
        return;
      }
      const radius = Math.min(30, Math.max(0, parseInt(args[0] ?? '3', 10) || 3));
      let removed = 0;
      for (const it of [...allItems({ world: ctx.world })]) {
        if (it.parent) continue;
        if (it.map !== ctx.sender.map) continue;
        if (Math.max(Math.abs(it.x - ctx.sender.x), Math.abs(it.y - ctx.sender.y)) > radius) continue;
        const pkt = api.protocol.removeEntity(it.serial);
        // BUGFIX #65 (PHASE CW): visibility-gate. Previously the loop
        // fanned removeEntity to EVERY client globally; now mirror
        // the canon UO 18-tile visibility radius via nearbyClients.
        for (const m of nearbyClients(ctx.world, it)) m.client.send(pkt);
        destroyItemBySerial({ world: ctx.world }, it.serial);
        removed++;
      }
      ctx.state.sendSystemMessage(`Removed ${removed} items within ${radius} tiles.`);
    },
  });
}
