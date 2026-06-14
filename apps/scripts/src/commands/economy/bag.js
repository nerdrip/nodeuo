// Demo script: `[bag` and `[stock` admin commands — spawn a backpack
// container at the sender's feet, optionally pre-filled with some test items.
//
// Useful for exercising the 0x06/0x24/0x25/0x3C container protocol without
// requiring art extraction or a vendor UI.

import { nearbyClients } from '../../_spatial.js';
import { createItem } from '../../_items.js';

const BACKPACK_ITEM_ID = 0x0E75; // "backpack" art graphic
const BACKPACK_GUMP_ID = 0x003C; // classic backpack gump

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  api.commands.register({
    name: 'bag',
    help: '[bag — spawn an empty backpack at your feet',
    run(ctx) {
      const bag = createItem(api, ctx.world, {
        itemId: BACKPACK_ITEM_ID,
        gumpId: BACKPACK_GUMP_ID,
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
      });
      // BUGFIX #65 (FAZA CW): visibility-gate.
      for (const other of nearbyClients(ctx.world, bag)) {
        other.client.sendItem(bag);
      }
      ctx.state.sendSystemMessage(`Bag 0x${bag.serial.toString(16)} spawned.`);
    },
  });

  api.commands.register({
    name: 'stock',
    help: '[stock — spawn a backpack at your feet with some test items',
    run(ctx) {
      const bag = createItem(api, ctx.world, {
        itemId: BACKPACK_ITEM_ID,
        gumpId: BACKPACK_GUMP_ID,
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
      });
      // A handful of well-known graphics: torch, gold, apple, key.
      const stock = [
        { itemId: 0x0A25, gridX: 30,  gridY: 40 },  // torch
        { itemId: 0x0EED, gridX: 80,  gridY: 40, amount: 500 }, // gold coins
        { itemId: 0x09D0, gridX: 30,  gridY: 90 },  // apple
        { itemId: 0x1010, gridX: 80,  gridY: 90 },  // iron key
      ];
      for (const s of stock) {
        createItem(api, ctx.world, {
          itemId: s.itemId,
          amount: s.amount ?? 1,
          gridX: s.gridX, gridY: s.gridY,
          parent: bag.serial,
          x: 0, y: 0, z: 0, map: 0,
        });
      }
      // BUGFIX #65 (FAZA CW): visibility-gate.
      for (const other of nearbyClients(ctx.world, bag)) {
        other.client.sendItem(bag);
      }
      ctx.state.sendSystemMessage(
        `Stocked bag 0x${bag.serial.toString(16)} with ${stock.length} items.`
      );
    },
  });
}
