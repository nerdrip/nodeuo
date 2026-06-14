// [broadcast — send a system message to every online client. Mirrors
// ServUO `Broadcast.cs`. Optional [-r] flag tints the message red
// (admin announcements). Default is server-message hue (yellow).
//
// Usage:
//   [broadcast The shard will reboot in 5 minutes.
//   [broadcast -r Critical announcement.

import { onlineMobiles } from '../../_spatial.js';

export default function (api) {
  const { commands } = api;

  commands.register({
    name: 'broadcast',
    help: 'Send a system message to every online client. -r for red.',
    access: 'GameMaster',
    run: (ctx) => {
      const args = ctx.args ?? [];
      let red = false;
      let start = 0;
      if (args[0] === '-r') { red = true; start = 1; }
      const text = args.slice(start).join(' ').trim();
      if (!text) { ctx.state.sendSystemMessage('Usage: [broadcast [-r] <text>'); return; }
      const tag = `<staff> ${text}`;
      let n = 0;
      for (const m of onlineMobiles(api)) {
        try {
          if (red && api.protocol?.unicodeMessage) {
            // Use UnicodeMessage with a system serial + red hue for
            // "important admin" formatting. Falls back to system below.
            m.client.send(api.protocol.unicodeMessage({
              serial: 0xFFFFFFFF, graphic: 0, type: 6 /* system */,
              hue: 0x35, font: 3, language: 'ENU', name: 'System', text: tag,
            }));
          } else {
            m.client.sendSystemMessage?.(tag);
          }
          n++;
        } catch { /* ignore */ }
      }
      ctx.state.sendSystemMessage(`Broadcast to ${n} client(s).`);
    },
  });

  // Alias matching ServUO's `[bc` shortcut.
  commands.register({
    name: 'bc',
    help: 'Alias for [broadcast.',
    access: 'GameMaster',
    run: (ctx) => commands.commands.get('broadcast')?.run?.(ctx),
  });

  return () => {
    commands.unregister('broadcast');
    commands.unregister('bc');
  };
}
