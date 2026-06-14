// `[help` — list every registered command, or `[help gump` → opens the
// in-game HelpGump (PageQueue routing + topic categories).
// Inspired by ServUO's built-in help system + HelpGump.cs.

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  api.commands.register({
    name: 'help',
    help: 'help [gump] — list commands, or open the Help menu.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === 'gump' || sub === 'menu') {
        ctx.state.sendSystemMessage?.('@@OPEN_HELP_GUMP@@');
        return;
      }
      const names = Array.from(api.commands.commands.keys()).sort();
      ctx.state.sendSystemMessage(`Commands (${names.length}):`);
      for (const name of names) {
        const def = api.commands.commands.get(name);
        ctx.state.sendSystemMessage(`  [${name}${def.help ? ' — ' + def.help.replace(/^.*—\s*/, '') : ''}`);
      }
    },
  });
}
