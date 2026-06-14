import { allMobiles } from '../../_spatial.js';
// `[trade <name>` — open a secure-trade window with another connected player.
//
// This is a dev/testing convenience. In classic UO trades are initiated by
// dragging an item onto another player; that drag path still has to be
// wired in the client, so for now we expose an explicit command.

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  api.commands.register({
    name: 'trade',
    help: 'trade <name> — open a secure-trade window with a player',
    access: 'Player',
    run(ctx, args) {
      const state = ctx.state;
      if (!state?.mobile) return;
      const targetName = (args[0] ?? '').trim();
      if (!targetName) {
        state.sendSystemMessage('Usage: [trade <name>');
        return;
      }
      const lower = targetName.toLowerCase();
      let partner = null;
      for (const m of allMobiles({ world: ctx.world })) {
        if (!m.client || m === state.mobile) continue;
        if (m.name?.toLowerCase() === lower) { partner = m; break; }
      }
      if (!partner) {
        state.sendSystemMessage(`Player "${targetName}" is not online.`);
        return;
      }
      const session = api.trade.open(state, partner.client);
      if (!session) state.sendSystemMessage('Could not open trade.');
    },
  });
}
