// Demo script: `[add <graphic>` admin command. Spawns an item at the sender's
// feet.
//
// This file lives under apps/scripts/ — a separate package from the core
// server — so scripts can be authored and hot-reloaded without touching
// server internals.

import { nearbyClients } from '../../_spatial.js';
import { createItem } from '../../_items.js';

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  api.commands.register({
    name: 'add',
    help: 'add <graphicId>[,hue] — spawn an item at your feet',
    run(ctx, args) {
      if (!args.length) {
        sendSystem(ctx, 'Usage: [add <graphicId>[,hue]');
        return;
      }
      const [graphic, hueStr] = args[0].split(',');
      const itemId = parseInt(graphic, 0); // supports 0x prefix
      if (!Number.isFinite(itemId) || itemId <= 0 || itemId > 0xFFFF) {
        sendSystem(ctx, `Invalid graphic id: ${args[0]}`);
        return;
      }
      const hue = hueStr ? parseInt(hueStr, 0) & 0xFFFF : 0;
      const item = createItem(api, ctx.world, {
        itemId, hue, x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
      });
      api.log(`[add] ${ctx.sender.name} spawned 0x${itemId.toString(16)} as 0x${item.serial.toString(16)} at (${item.x},${item.y},${item.z})`);
      // BUGFIX #65 (FAZA CW): the original loop fanned the `sendItem`
      // out to EVERY connected client. A single `[add` in Britain
      // pinged every player on the shard, including those on Felucca
      // / a different facet. Filter by map + 18-tile visibility, the
      // same gate canon UO uses.
      for (const other of nearbyClients(ctx.world, item)) {
        other.client.sendItem(item);
      }
      sendSystem(ctx, `Spawned item 0x${itemId.toString(16)}.`);
    },
  });
}

function sendSystem(ctx, text) {
  ctx.state.sendSystemMessage(text);
}
