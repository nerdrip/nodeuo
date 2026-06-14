// [kick — disconnect a player without banning them. Mirrors ServUO
// `KickCommand` (Scripts/Commands/General/Kick.cs). Pair with `[ban`
// when permanence is desired.
//
// Usage:
//   [kick <username>          kick all sessions of that account
//   [kick                     cursor-target a logged-in mobile

import { resolveMobileArg } from '../_targeting-helpers.js';
import { allMobiles } from '../../_spatial.js';

export default function (api) {
  const { commands, world } = api;

  function kickByAccountName(name) {
    const lower = String(name).toLowerCase();
    let n = 0;
    for (const m of allMobiles({ world })) {
      if (!m.client) continue;
      const acct = m.client?.accountName ?? m.accountName;
      if (acct && acct.toLowerCase() === lower) {
        try { m.client.ws?.close?.(); } catch { /* ignore */ }
        n++;
      }
    }
    return n;
  }

  commands.register({
    name: 'kick',
    help: 'Disconnect a player without banning them.',
    access: 'GameMaster',
    run: (ctx) => {
      const arg = ctx.args?.[0];
      if (arg) {
        const n = kickByAccountName(arg);
        ctx.state.sendSystemMessage(n === 0 ? `No online sessions for ${arg}.` : `Kicked ${n} session(s) of ${arg}.`);
        return;
      }
      resolveMobileArg(api, ctx, 0, (m) => {
        if (!m) return;
        if (!m.client) { ctx.state.sendSystemMessage('Target is not online.'); return; }
        try { m.client.ws?.close?.(); }
        catch (e) { console.error('[kick] close failed', e); }
        ctx.state.sendSystemMessage(`Kicked ${m.name ?? 'target'}.`);
      });
    },
  });

  return () => commands.unregister('kick');
}
