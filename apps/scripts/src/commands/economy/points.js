// `[points` — list per-account currency balances (champion/invasion/cleanup/etc).

export default function register(api) {
  if (!api.commands) return () => {};
  const points = api.systems?.points;
  if (!points) {
    api.log?.('points: points system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'points',
    help: '[points — list all your award currency balances.',
    access: 'Player',
    run(ctx) {
      const acc = ctx.sender?.account ?? ctx.state?.account;
      if (!acc) { ctx.state.sendSystemMessage('No account state.'); return; }
      const d = points.dump(acc);
      ctx.state.sendSystemMessage('Award balances:');
      for (const k of points.listKinds()) {
        ctx.state.sendSystemMessage(`  ${k.padEnd(12)} ${d[k]}`);
      }
    },
  });

  api.commands.register({
    name: 'awardpoints',
    help: '[awardpoints <kind> <n> — GM: grant award currency.',
    access: 'GameMaster',
    run(ctx, args) {
      const acc = ctx.sender?.account ?? ctx.state?.account;
      const kind = String(args?.[0] ?? '');
      const n = parseInt(args?.[1] ?? '0', 10) | 0;
      if (!acc || !kind) { ctx.state.sendSystemMessage('Usage: [awardpoints <kind> <n>'); return; }
      const after = points.award(acc, kind, n);
      ctx.state.sendSystemMessage(`${kind}: ${points.balance(acc, kind) - n} -> ${after}.`);
    },
  });

  return () => {
    api.commands.unregister('points');
    api.commands.unregister('awardpoints');
  };
}
