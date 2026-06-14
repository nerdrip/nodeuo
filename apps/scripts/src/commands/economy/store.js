// `[store` — Ultima Store catalogue (sovereigns currency).
//   [store              → catalogue
//   [store balance      → your sovereigns
//   [store buy <id>     → spend sovereigns

export default function register(api) {
  if (!api.commands) return () => {};
  const store = api.systems?.ultimaStore;
  if (!store) {
    api.log?.('store: ultima store system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'store',
    help: '[store | balance | buy <id> — Ultima Store (sovereigns).',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      const acc = ctx.sender?.account ?? ctx.state?.account;
      if (sub === 'gump') {
        const rows = store.catalogue().map((it) => `${it.id}|${it.label}|${it.cost}|${it.category}`).join(';');
        ctx.state.sendSystemMessage?.(`@@OPEN_STORE_GUMP@@${store.balance(acc)}|${rows}`);
        return;
      }
      if (sub === 'balance') {
        ctx.state.sendSystemMessage(`Sovereigns: ${store.balance(acc)}.`);
        return;
      }
      if (sub === 'buy') {
        const id = String(args?.[1] ?? '');
        const r = store.buy(acc, ctx.sender, id, api);
        ctx.state.sendSystemMessage(r.ok
          ? `Bought ${r.item.label}. ${r.remaining} sovereigns left.`
          : r.reason);
        return;
      }
      ctx.state.sendSystemMessage(`Catalogue (${store.balance(acc)} sovereigns):`);
      for (const it of store.catalogue()) {
        ctx.state.sendSystemMessage(`  ${it.id} — ${it.label}  (${it.cost} sov, ${it.category})`);
      }
    },
  });
  return () => api.commands.unregister('store');
}
