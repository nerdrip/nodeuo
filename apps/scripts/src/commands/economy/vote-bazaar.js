// `[vote-bazaar` — Magincia bazaar vendor voting (one vote per stall
// per cycle, 7-day cycles).

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.maginciaDistillation;
  if (!sys) return () => {};

  api.commands.register({
    name: 'vote-bazaar',
    help: '[vote-bazaar status|cast <stallId> <vendorSerial>|winner <stallId>',
    access: 'Player',
    run(ctx, args) {
      const sub = args?.[0] ?? 'status';
      if (sub === 'status') {
        ctx.state.sendSystemMessage(`Current cycle: ${sys.currentCycle()}`);
        return;
      }
      if (sub === 'cast') {
        const stall = args?.[1];
        const vendorSer = parseInt(args?.[2] ?? '0', 16);
        const acct = ctx.state.account ?? ctx.sender.account;
        if (!acct) { ctx.state.sendSystemMessage('No account context.'); return; }
        const ok = sys.castVote(acct, stall, vendorSer);
        ctx.state.sendSystemMessage(ok ? 'Vote cast.' : 'Already voted this cycle.');
        return;
      }
      if (sub === 'winner') {
        const stall = args?.[1];
        const w = sys.winner(stall);
        ctx.state.sendSystemMessage(w
          ? `Leading: 0x${w.serial.toString(16)} (${w.votes} votes)`
          : 'No votes yet.');
        return;
      }
    },
  });

  return () => api.commands.unregister('vote-bazaar');
}
