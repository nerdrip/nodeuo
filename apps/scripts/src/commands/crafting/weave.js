// `[weave` — basket weaving craft.
//   [weave list           → recipes
//   [weave <recipe name>  → attempt to weave

export default function register(api) {
  if (!api.commands) return () => {};
  const weaving = api.systems?.basketWeaving;
  if (!weaving) {
    api.log?.('weave: basket weaving system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'weave',
    help: '[weave list  /  [weave <recipe> — basket weaving.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === '' || sub === 'list') {
        ctx.state.sendSystemMessage('Basket recipes:');
        for (const name of weaving.recipeNames()) {
          const r = weaving.recipe(name);
          ctx.state.sendSystemMessage(`  ${name} — ${r.reeds} reeds, tinkering ${r.skill}`);
        }
        return;
      }
      const name = (args ?? []).join(' ');
      const r = weaving.tryWeave(ctx.state, name, api);
      ctx.state.sendSystemMessage(r.ok ? `You weave a ${r.label}.` : r.reason);
    },
  });
  return () => api.commands.unregister('weave');
}
