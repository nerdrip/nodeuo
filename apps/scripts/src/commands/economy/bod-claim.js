// `[bod-claim` — claim a completed Bulk Order Deed's reward without
// turning it in to a vendor. ServUO normally requires you to walk to
// the matching town crafter (blacksmith / tailor) and use the deed
// on them. Vendor turn-in still works for the gold-only path
// (`bods.tryTurnInBod`); this command surfaces the **gift** reward
// table (runic tool / recipe scroll / coloured material) that the
// canonical UO BOD-reward gump offers.
//
// Mirrors `Engines/BulkOrders/BODRewardGump.cs` minus the visual gump.

import { bodsSystem } from '../../_bods.js';
import { itemBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};
  const bods = bodsSystem(api);
  if (!bods) {
    api.log?.('bod-claim: BOD system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'bod-claim',
    help: '[bod-claim — target a completed BOD in your pack to claim the gift reward.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Target the completed BOD.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it?.bod) {
          ctx.state.sendSystemMessage('That is not a Bulk Order Deed.');
          return;
        }
        if (it.parent !== ctx.sender.serial) {
          ctx.state.sendSystemMessage('You must carry the deed.');
          return;
        }
        const reward = bods.claimBodReward?.(api.world, ctx.sender, it, {
          createItem: (world, data) => createItem(api, world, data),
          destroyItem: (_world, serial) => destroyItemBySerial(api, serial),
        });
        if (!reward) ctx.state.sendSystemMessage('That BOD is not yet complete.');
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('bod-claim');
}
