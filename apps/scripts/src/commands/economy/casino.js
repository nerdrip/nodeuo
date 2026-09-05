// `[casino` — Fire Casino slot pull (100 gp).

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'casino',
    help: '[casino [gump] — pull the Fire Casino slot machine (100 gp) or open the dice gump.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === 'gump' || sub === 'dice') {
        // Phase H.2 — emit sentinel so the dice gump opens client-side.
        ctx.state.sendSystemMessage?.('@@OPEN_CASINO_GUMP@@');
        return;
      }
      const r = api.systems?.fireCasino?.pull?.(ctx.state, api)
        ?? { ok: false, reason: 'Casino system unavailable.' };
      if (!r.ok) { ctx.state.sendSystemMessage(r.reason); return; }
      ctx.state.sendSystemMessage(`Reels: ${r.reels.join(' | ')}`);
      ctx.state.sendSystemMessage(r.payout > 0
        ? `You win ${r.payout} gold!` : 'No payout.');
    },
  });
  return () => api.commands.unregister('casino');
}
