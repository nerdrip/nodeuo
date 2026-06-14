// [shutdown — graceful server shutdown with optional countdown. Mirrors
// ServUO `Shutdown.cs`: announces over global system message at the
// half-way and 1-minute marks, performs a final save, then exits the
// process. Default delay is 60 seconds; pass 0 for "right now" (still
// after final save).
//
// Usage:
//   [shutdown                 60-second countdown
//   [shutdown <seconds>       custom delay (clamped to [0, 3600])
//   [shutdown abort           cancel a pending shutdown
//
// Permission: Admin only — incidents involving accidental shutdowns by
// counselors are exactly the class of mistake this gate prevents.

import { onlineMobiles } from '../../_spatial.js';

let pendingTimer = null;
let pendingAt = 0;

function broadcastSystem(api, text) {
  for (const m of onlineMobiles(api)) m.client?.sendSystemMessage?.(text);
}

export default function (api) {
  const { commands, world, persistence } = api;

  commands.register({
    name: 'shutdown',
    help: 'Graceful server shutdown after <seconds> (default 60). Use "abort" to cancel.',
    access: 'Admin',
    run: (ctx) => {
      const arg = ctx.args?.[0];
      if (arg && /^abort$/i.test(arg)) {
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
          pendingAt = 0;
          broadcastSystem(api, 'Server shutdown aborted by an administrator.');
          return;
        }
        ctx.state.sendSystemMessage('No shutdown is pending.');
        return;
      }
      if (pendingTimer) {
        const remaining = Math.max(0, Math.round((pendingAt - Date.now()) / 1000));
        ctx.state.sendSystemMessage(`Shutdown already pending in ${remaining}s. Use "[shutdown abort" to cancel.`);
        return;
      }
      const seconds = Math.max(0, Math.min(3600, parseInt(arg ?? '60', 10) || 60));
      pendingAt = Date.now() + seconds * 1000;
      const fire = () => {
        broadcastSystem(api, 'The server is shutting down NOW.');
        try { persistence?.saveWorldSync?.(world, persistence.saveDir); } catch (e) { console.error('[shutdown] save', e); }
        // Give the WS frames a tick to flush.
        setTimeout(() => process.exit(0), 250);
      };
      if (seconds === 0) { fire(); return; }
      broadcastSystem(api, `The server will shut down in ${seconds} seconds.`);
      // Half-way and 60s warnings — only schedule those that fall before
      // the actual fire moment.
      const halfway = Math.floor(seconds / 2);
      if (halfway > 5 && halfway !== seconds && halfway !== 60) {
        setTimeout(() => broadcastSystem(api, `Server shutdown in ${halfway} seconds.`), (seconds - halfway) * 1000).unref();
      }
      if (seconds > 60) {
        setTimeout(() => broadcastSystem(api, 'Server shutdown in 60 seconds.'), (seconds - 60) * 1000).unref();
      }
      if (seconds > 10) {
        setTimeout(() => broadcastSystem(api, 'Server shutdown in 10 seconds.'), (seconds - 10) * 1000).unref();
      }
      pendingTimer = setTimeout(fire, seconds * 1000);
      ctx.state.sendSystemMessage(`Shutdown scheduled in ${seconds}s.`);
    },
  });

  return () => commands.unregister('shutdown');
}
