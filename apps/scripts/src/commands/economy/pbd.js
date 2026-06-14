// `[pbd` — Personal Bless Deed. Target a worn item to bless it for
// the account; survives death. Deed is consumed on success.

import { findInPack } from '../../_inventory.js';
import { itemBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'pbd',
    help: '[pbd — target a worn item to bless it (account-bound, survives death).',
    access: 'Player',
    run(ctx) {
      const account = ctx.state?.account;
      if (!account) {
        ctx.state.sendSystemMessage('No account context.');
        return;
      }
      // Find a Personal Bless Deed (0x14F0) in pack.
      const deed = findInPack(api, ctx.sender, (it) => it.itemId === 0x14F0 && it._isPersonalBlessDeed);
      if (!deed) {
        ctx.state.sendSystemMessage('You have no Personal Bless Deed in your pack.');
        return;
      }
      ctx.state.sendSystemMessage('Target a worn item to bless.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item || item.parent !== ctx.sender.serial || (item.layer ?? 0) === 0) {
          ctx.state.sendSystemMessage('You can only bless equipped items.');
          return;
        }
        const ok = api.systems?.personalBless?.applyPersonalBless?.(api.world, account, item);
        if (!ok) {
          ctx.state.sendSystemMessage('That item is already blessed.');
          return;
        }
        try { destroyItemBySerial(api, deed.serial); }
        catch { /* ignore */ }
        ctx.state.sendSystemMessage(
          `${item.name ?? 'The item'} is bound to your soul — it will return after death.`);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('pbd');
}
