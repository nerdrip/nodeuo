// `[krampus` — open the nice/naughty ledger gump for the local player.
// ServUO `KrampusGump.cs` equivalent. Sends sentinel
// `@@OPEN_KRAMPUS_GUMP@@<nice>|<naughty>` so the client overlay opens.

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'krampus',
    help: '[krampus [gump|status] — show your nice/naughty score.',
    access: 'Player',
    run(ctx, args) {
      const acc = ctx.sender?.account ?? ctx.state?.account;
      const s = api.systems?.krampusEvent?.scoreOf?.(acc) ?? { nice: 0, naughty: 0 };
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === '' || sub === 'gump' || sub === 'ledger') {
        ctx.state.sendSystemMessage?.(`@@OPEN_KRAMPUS_GUMP@@${s.nice | 0}|${s.naughty | 0}`);
        return;
      }
      if (sub === 'status') {
        ctx.state.sendSystemMessage(`Krampus: nice=${s.nice | 0}, naughty=${s.naughty | 0}.`);
      }
    },
  });
  return () => api.commands.unregister('krampus');
}
