// `[guild-info` — opens the GuildGump for the player's current guild.

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.serverGumps;
  if (!sys) return () => {};

  api.commands.register({
    name: 'guild-info',
    help: '[guild-info — open guild roster gump.',
    access: 'Player',
    run(ctx) {
      const gumps = api.gumps;
      if (!gumps?.send) {
        ctx.state.sendSystemMessage('Gump dispatcher unavailable.');
        return;
      }
      const guildSys = api.systems?.guild ?? api.systems?.guilds;
      const guild = guildSys?.findByMember?.(ctx.sender.serial)
                 ?? guildSys?.guildOf?.(ctx.sender);
      if (!guild) {
        ctx.state.sendSystemMessage('You are not in a guild.');
        return;
      }
      sys.openGuildGump(gumps, ctx.state, guild);
    },
  });

  return () => api.commands.unregister('guild-info');
}
