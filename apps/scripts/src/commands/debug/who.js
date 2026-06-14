// `[who` — print a list of connected players.
// Inspired by ServUO's Scripts/Commands/Who.cs.

import { onlineMobiles } from '../../_spatial.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  api.commands.register({
    name: 'who',
    help: 'who — list connected players',
    access: 'Player',
    run(ctx) {
      const rows = [];
      for (const m of onlineMobiles(api)) {
        rows.push(`  ${m.name} (#${m.serial.toString(16)}) @ (${m.x},${m.y},${m.z}) map=${m.map}`);
      }
      if (!rows.length) {
        ctx.state.sendSystemMessage('No players online.');
        return;
      }
      ctx.state.sendSystemMessage(`Online (${rows.length}):`);
      for (const line of rows) ctx.state.sendSystemMessage(line);
    },
  });
}
