// `[quota` — daily harvest quota status + ticket redemption.
//
//   [quota          — show today's mining/lumber counts + ticket pool
//   [quota claim <tier> — redeem one ticket of the given tier
//
// Quotas are tracked per-account by `systems/economy/harvest-quotas.js`. The
// `[mine` / `[chop` commands call `recordHarvest(account, kind)` on
// each successful swing; ticket grants are sent to the player as a
// system message at the moment of award.

export default function register(api) {
  if (!api.commands) return () => {};
  const quotas = api.systems?.harvestQuotas;
  if (!quotas) {
    api.log?.('quota: harvest quota system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'quota',
    help: '[quota / [quota claim <tier> — daily harvest quota tickets.',
    access: 'Player',
    run(ctx) {
      const account = ctx.state?.account;
      if (!account) { ctx.state.sendSystemMessage?.('No account.'); return; }
      const sub = String(ctx.args[0] ?? '').toLowerCase();

      if (sub === 'claim') {
        const tier = String(ctx.args[1] ?? '').toLowerCase();
        if (!tier) {
          ctx.state.sendSystemMessage?.('Usage: [quota claim <bronze|silver|gold|platinum>');
          return;
        }
        const r = quotas.redeemTicket(account, tier);
        if (!r.ok) {
          ctx.state.sendSystemMessage?.(`Cannot redeem: ${r.reason}`);
          return;
        }
        try {
          const item = api.game?.mobile?.giveItem?.(ctx.sender, {
            itemId: r.reward.itemId, hue: r.reward.hue,
            name: r.reward.name,
            movable: true,
          });
          if (!item) { ctx.state.sendSystemMessage?.('No backpack.'); return; }
        } catch (e) {
          ctx.state.sendSystemMessage?.(`Reward spawn failed: ${e.message}`);
          return;
        }
        ctx.state.sendSystemMessage?.(
          `Redeemed ${r.tier} ticket → ${r.reward.name}.`,
        );
        return;
      }

      const counts = quotas.harvestCounts(account);
      const tickets = quotas.ticketsOf(account);
      ctx.state.sendSystemMessage?.(`Today's harvest:`);
      ctx.state.sendSystemMessage?.(`  Mining:        ${counts.mining}`);
      ctx.state.sendSystemMessage?.(`  Lumberjacking: ${counts.lumber}`);
      const tierList = Object.entries(tickets).filter(([_, n]) => n > 0);
      if (tierList.length === 0) {
        ctx.state.sendSystemMessage?.('Tickets: none yet — keep harvesting!');
      } else {
        ctx.state.sendSystemMessage?.('Tickets:');
        for (const [t, n] of tierList) {
          ctx.state.sendSystemMessage?.(`  ${t.padEnd(10)} × ${n}`);
        }
        ctx.state.sendSystemMessage?.('[quota claim <tier> to redeem.');
      }
    },
  });

  return () => api.commands.unregister('quota');
}
