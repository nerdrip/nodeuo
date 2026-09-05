// `[hunt` — Huntmaster Challenge leaderboard query.
//
//   [hunt           → current rotation target
//   [hunt top       → top 10 of the week
//   [hunt mine      → your best score this week

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  const huntmaster = api.systems?.huntmaster ?? {
    currentTarget: () => ({ kind: 'unknown', name: 'Hunt', tier: 0 }),
    top: () => [],
  };

  api.commands.register({
    name: 'hunt',
    help: '[hunt | [hunt top | [hunt mine — Huntmaster Challenge weekly contest.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === 'gump' || sub === 'trophy') {
        // Phase H.4 — open the trophy display client overlay.
        const tgt = huntmaster.currentTarget();
        const board = huntmaster.top(api.world, 10);
        const rows = board.map((e, i) =>
          `${i + 1}|${(e.name ?? '?').replace(/[|;]/g, '_')}|${e.score | 0}`,
        ).join(';');
        const payload = [
          (tgt.kind ?? '?'), (tgt.name ?? 'Hunt'), (tgt.tier | 0),
          rows,
        ].join('||');
        ctx.state.sendSystemMessage?.(`@@OPEN_HUNTMASTER_GUMP@@${payload}`);
        return;
      }
      if (sub === 'top') {
        const board = huntmaster.top(api.world, 10);
        if (board.length === 0) { ctx.state.sendSystemMessage('No entries this week.'); return; }
        ctx.state.sendSystemMessage(`Huntmaster Challenge — top 10:`);
        board.forEach((e, i) => ctx.state.sendSystemMessage(
          `  ${(i + 1).toString().padStart(2)}. ${e.name} — ${e.score}`,
        ));
        return;
      }
      if (sub === 'mine') {
        const board = huntmaster.top(api.world, 999);
        const me = board.find((e) => e.serial === ctx.sender?.serial);
        ctx.state.sendSystemMessage(me
          ? `Your best score: ${me.score} (rank ${board.indexOf(me) + 1}).`
          : 'You have not turned in a trophy yet this week.');
        return;
      }
      const tgt = huntmaster.currentTarget();
      ctx.state.sendSystemMessage(
        `This week's quarry: ${tgt.kind} (${tgt.name}). Slay one and submit at any Huntmaster.`,
      );
    },
  });
  return () => api.commands.unregister('hunt');
}
