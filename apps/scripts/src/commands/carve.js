import { itemBySerial } from '../_entities.js';

export default function register(api) {
  if (!api.commands || !api.targeting || !api.corpse?.carveCorpse) return () => {};
  api.commands.register({
    name: 'carve',
    help: '[carve — target a nearby corpse with a bladed tool.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage?.('Target the corpse you wish to carve.');
      api.targeting.request(ctx.state, (picked) => {
        const corpse = itemBySerial(api, picked?.serial >>> 0);
        const result = api.corpse.carveCorpse(api.world, corpse, ctx.sender);
        if (!result.ok) {
          const message = result.reason === 'already-carved' ? 'That corpse has already been carved.'
            : result.reason === 'loot-rights' ? 'You do not yet have the right to carve that corpse.'
              : result.reason === 'out-of-range' ? 'That corpse is too far away.'
                : 'That is not a corpse.';
          ctx.state.sendSystemMessage?.(message);
          return;
        }
        for (const item of result.items) {
          ctx.state.send?.(api.protocol?.containerContentUpdate?.(item, corpse.serial));
        }
        ctx.state.sendSystemMessage?.(result.items.length
          ? `You carve ${result.items.map((item) => item.name).join(', ')} from the corpse.`
          : 'There is nothing useful to carve from this corpse.');
      }, { kind: 0 });
    },
  });
  return () => api.commands.unregister('carve');
}
