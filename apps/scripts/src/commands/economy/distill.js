import { destroyItemBySerial } from '../../_items.js';
import { itemBySerial } from '../../_entities.js';
// `[distill <itemId>` and `[drink-distilled` — New Magincia distillation.

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.maginciaDistillation;
  if (!sys) return () => {};

  api.commands.register({
    name: 'distill',
    help: '[distill — distill 3 wine/ale/cider into 1 concentrated potion.',
    access: 'Player',
    run(ctx, args) {
      const itemId = parseInt(args?.[0] ?? '0', 16);
      if (!itemId) {
        ctx.state.sendSystemMessage('Usage: [distill <hex-itemId>. Recipes:');
        for (const r of sys.recipes()) {
          ctx.state.sendSystemMessage(`  3× ${r.input} → ${r.name} (+${r.buffAmount} ${r.buffStat})`);
        }
        return;
      }
      const r = sys.distill(api.world, ctx.sender, itemId);
      if (!r.ok) { ctx.state.sendSystemMessage(`Distill failed: ${r.reason}`); return; }
      ctx.state.sendSystemMessage(`You distill ${r.recipe.name}.`);
    },
  });

  api.commands.register({
    name: 'drink-distilled',
    help: '[drink-distilled — target a distilled potion to drink.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Target a distilled potion.');
      api.targeting?.request?.(ctx.state, (picked) => {
        if (!picked) return;
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it) return;
        if (sys.drinkDistilled(ctx.sender, it)) {
          destroyItemBySerial(api, it.serial);
          ctx.state.sendSystemMessage('You drink it. A potent buff washes over you.');
        } else {
          ctx.state.sendSystemMessage('That is not a distilled potion.');
        }
      });
    },
  });

  return () => {
    api.commands.unregister('distill');
    api.commands.unregister('drink-distilled');
  };
}
