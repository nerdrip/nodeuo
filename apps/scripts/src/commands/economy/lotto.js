// `[lotto` — Housing Lotto controls.
//   [lotto status <plotId>     → tickets + close time
//   [lotto buy <plotId>        → 1k gp ticket
//   [lotto draw <plotId>       → GM/admin manual draw

export default function register(api) {
  if (!api.commands) return () => {};
  const lotto = api.systems?.housingLotto;
  if (!lotto) {
    api.log?.('lotto: housing lotto system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'lotto',
    help: '[lotto status|buy|draw <plotId> — Housing Lotto.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      const plotId = String(args?.[1] ?? '');
      if (!plotId) { ctx.state.sendSystemMessage('Usage: [lotto <sub> <plotId>'); return; }
      if (sub === 'status') {
        const s = lotto.status(api.world, plotId);
        ctx.state.sendSystemMessage(
          `plot ${plotId}: tickets=${s.tickets}, closes in ${(s.msUntilClose/3600_000).toFixed(2)}h, winner=${s.winner?.name ?? '-'}`,
        );
        return;
      }
      if (sub === 'buy') {
        const r = lotto.buyTicket(api.world, plotId, ctx.sender);
        ctx.state.sendSystemMessage(r.ok
          ? `Ticket bought. You have entries on plot ${plotId}.`
          : r.reason);
        return;
      }
      if (sub === 'draw') {
        const w = lotto.drawWinner(api.world, plotId);
        ctx.state.sendSystemMessage(w
          ? `Winner: ${w.name} (${(w.serial>>>0).toString(16)})`
          : 'No winner yet (round still open or no tickets).');
        return;
      }
      ctx.state.sendSystemMessage('Usage: [lotto status|buy|draw <plotId>');
    },
  });
  return () => api.commands.unregister('lotto');
}
