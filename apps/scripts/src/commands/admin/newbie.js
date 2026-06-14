import { itemBySerial } from '../../_entities.js';
// FAZA ET — `[newbie` admin command marks a target item as
// LootType.Blessed (kept on death). Companion to insurance: insurance
// is paid by gold, newbied is a static flag set by GMs / starter kits.

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'newbie',
    help: '[newbie — flag a target item as newbied (kept on death).',
    access: 'GameMaster',
    run(ctx) {
      ctx.state.sendSystemMessage('Newbie which item?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) return;
        item.newbied = !item.newbied;
        ctx.state.sendSystemMessage(
          item.newbied ? 'Item is now newbied.' : 'Newbie flag cleared.',
        );
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('newbie');
}
