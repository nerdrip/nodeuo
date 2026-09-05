// `[guildbook` — guild roster gump.
//
// Phase H.3 UNIFICATION: previously this command sent a server-rendered
// 0xB0 gump (`api.gumps.send`) while `[guild gump` emitted a sentinel
// for the client-side overlay. Two gumps for the same data — confusing
// for players. Now `[guildbook` ALSO emits the sentinel so both verbs
// open the SAME GuildGump overlay. The richer overlay wins; the 0xB0
// layout code is removed.

import { mobileBySerial } from '../../_entities.js';

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'guildbook',
    help: '[guildbook — open the guild roster gump (same as `[guild gump`).',
    access: 'Player',
    run(ctx) {
      const player = ctx.sender;
      const guild = player._guild ?? api.guilds?.guildOf?.(player.serial) ?? null;
      if (!guild) {
        ctx.state.sendSystemMessage('You belong to no guild. Use `[guild create <name>`.');
        return;
      }
      const members = (guild.members ?? [])
        .map((s) => mobileBySerial(api, s >>> 0))
        .filter(Boolean)
        .map((m) => `${(m.name ?? '?').replace(/[|;]/g, '_')}|${m.client ? 1 : 0}|${(m.serial >>> 0) === (guild.leader >>> 0) ? 'leader' : 'member'}`)
        .join(';');
      const payload = [
        (guild.name ?? 'Unnamed').replace(/[|;]/g, '_'),
        (guild.abbr ?? '').replace(/[|;]/g, '_'),
        (guild.type ?? 'Standard').replace(/[|;]/g, '_'),
        members,
      ].join('||');
      ctx.state.sendSystemMessage?.(`@@OPEN_GUILD_GUMP@@${payload}`);
    },
  });

  return () => api.commands.unregister('guildbook');
}
