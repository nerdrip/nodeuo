import { itemBySerial } from '../../_entities.js';
// FAZA EP — `[dye <hue>` dye tub.
//
// ServUO `Items/Resource/DyeTub.cs`: lets players hue clothing items
// to a fixed colour. We expose a player command — given a target
// item in their pack and a hue (0..0xFFFF), set item.hue.
//
// Restriction: only items already on a "dyeable" layer (5 = shirt,
// 13 = chest armor, 22 = robe, 20 = cloak, 4 = pants, 24 = leggings).

const DYEABLE_LAYERS = new Set([3, 4, 5, 6, 12, 13, 20, 22, 24]);

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'dye',
    help: '[dye <hue> — hue an item; target it after typing.',
    access: 'Player',
    run(ctx) {
      const hue = parseInt(ctx.args[0] ?? '', 0);
      if (!Number.isFinite(hue) || hue < 0 || hue > 0xFFFF) {
        ctx.state.sendSystemMessage('Usage: [dye <hue 0..0xFFFF>');
        return;
      }
      ctx.state.sendSystemMessage('Dye which item?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) {
          ctx.state.sendSystemMessage('Cancelled.');
          return;
        }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) {
          ctx.state.sendSystemMessage('Not an item.');
          return;
        }
        if (!DYEABLE_LAYERS.has(item.layer ?? 0) && item.parent !== ctx.sender.serial) {
          ctx.state.sendSystemMessage('You can only dye clothing in your pack or on you.');
          return;
        }
        item.hue = hue;
        ctx.state.sendSystemMessage(`You dye the item hue 0x${hue.toString(16)}.`);
        // Push update.
        if (api.protocol?.containerContentUpdate && ctx.sender.client) {
          ctx.sender.client.send(api.protocol.containerContentUpdate({
            serial: item.serial, itemId: item.itemId, amount: item.amount ?? 1,
            hue: item.hue, gridX: 0, gridY: 0, gridLocation: 0,
          }, item.parent ?? ctx.sender.serial));
        }
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('dye');
}
