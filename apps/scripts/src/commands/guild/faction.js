// PHASE BY — `[faction <name|leave|status>` user command.
//
// Joining is intentionally a single-step operation; ServUO has a 3-day
// recruit waiting period that we deliberately skip for MVP. Leaving
// preserves kill count so a returning player keeps their rank.

export default function register(api) {
  if (!api.commands) return () => {};
  const factions = api.systems?.factions;
  if (!factions) {
    api.log?.('faction: factions system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'faction',
    help: '[faction <council|minax|shadowlords|truebrits|leave|status>',
    run(ctx, args) {
      const sub = String(args[0] ?? 'status').toLowerCase();
      const mob = ctx.sender;
      if (sub === 'status') {
        if (!mob.faction) {
          ctx.state.sendSystemMessage('You belong to no faction.');
          return;
        }
        const r = factions.rankOf(mob);
        const f = factions.FACTIONS[mob.faction];
        ctx.state.sendSystemMessage(
          `Faction: ${f.name}. Rank ${r.rank} (${r.name}). Kills: ${mob.factionKills | 0}.`,
        );
        return;
      }
      if (sub === 'leave') {
        if (factions.leaveFaction(mob)) {
          ctx.state.sendSystemMessage('You renounce your faction.');
        } else {
          ctx.state.sendSystemMessage('You are not in a faction.');
        }
        return;
      }
      if (factions.FACTIONS[sub]) {
        if (factions.joinFaction(mob, sub)) {
          ctx.state.sendSystemMessage(`You join ${factions.FACTIONS[sub].name}.`);
        } else if (mob.faction === sub) {
          ctx.state.sendSystemMessage(`You already belong to ${factions.FACTIONS[sub].name}.`);
        } else {
          ctx.state.sendSystemMessage('Faction join failed.');
        }
        return;
      }
      ctx.state.sendSystemMessage(
        `Usage: [faction <${Object.keys(factions.FACTIONS).join(' | ')} | leave | status>`,
      );
    },
  });

  return () => {
    api.commands.unregister('faction');
  };
}
