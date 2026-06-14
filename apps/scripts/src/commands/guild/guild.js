// [guild join <name> | leave | say <msg>

import { mobileBySerial } from '../../_entities.js';

export default function (api) {
  const { commands, guilds } = api;
  if (!guilds) return;

  commands.register({
    name: 'guild',
    help: 'Usage: [guild join <name> | leave | say <msg>',
    access: 'Player',
    // Second positional parameter is the tokenised argv — same bug fix as
    // partysay: ctx.args doesn't exist on the dispatch context.
    run: (ctx, args) => {
      const state = ctx.state;
      if (!state?.mobile) return;
      const argv = args ?? [];
      const sub = (argv[0] ?? '').toLowerCase();
      if (sub === 'join') {
        const name = argv.slice(1).join(' ').trim();
        if (!name) { state.sendSystemMessage?.('Usage: [guild join <name>'); return; }
        guilds.join(state.mobile.serial, name);
        state.sendSystemMessage?.(`Joined guild: ${name}`);
      } else if (sub === 'leave') {
        guilds.leave(state.mobile.serial);
        state.sendSystemMessage?.('You have left your guild.');
      } else if (sub === 'say') {
        const msg = argv.slice(1).join(' ').trim();
        if (!msg) return;
        guilds.chat(state.mobile.serial, msg);
      } else if (sub === 'gump') {
        // Faza H.2 — emit sentinel so client opens the rich GuildGump
        // overlay (roster + charter + wars tabs).
        const guild = state.mobile._guild
                   ?? guilds.guildOf?.(state.mobile.serial)
                   ?? null;
        if (!guild) {
          state.sendSystemMessage?.('You belong to no guild.');
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
        state.sendSystemMessage?.(`@@OPEN_GUILD_GUMP@@${payload}`);
      } else {
        state.sendSystemMessage?.('Usage: [guild join <name> | leave | say <msg> | gump');
      }
    },
  });

  return () => commands.unregister('guild');
}
