// `[srvstats` — print a server snapshot (admins/GMs).

export default function register(api) {
  if (!api.commands) return () => {};
  const reports = api.systems?.reports;
  if (!reports) {
    api.log?.('srvstats: reports system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'srvstats',
    help: '[srvstats — server snapshot (online players, items, NPCs).',
    access: 'GameMaster',
    run(ctx) {
      const snap = reports.gatherSnapshot(api.world, {
        netStates: api.netStates,
        startedAt: api.startedAt ?? Date.now(),
      });
      ctx.state.sendSystemMessage(reports.formatSnapshot(snap));
    },
  });
  return () => api.commands.unregister('srvstats');
}
