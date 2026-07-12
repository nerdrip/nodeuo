// `[light <level>` — broadcast an overall light-level packet to everyone.
// Level 0 is brightest day, 0x1F is pitch black.
// Inspired by ServUO's Light command (Scripts/Commands/Generic/Light.cs).

import { sendToOnline } from '../../_spatial.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  api.commands.register({
    name: 'light',
    help: 'light <level> — pin overall light level (0..30; use [setlight auto to resume)',
    run(ctx, args) {
      if (!args.length) { ctx.state.sendSystemMessage('Usage: [light <0..30>'); return; }
      const level = Math.max(0, Math.min(30, parseInt(args[0], 10) || 0));
      if (api.dayNight?.forceLevel) api.dayNight.forceLevel(level);
      else sendToOnline(api, api.protocol.overallLightLevel(level));
      ctx.state.sendSystemMessage(`Light level → ${level}.`);
    },
  });
}
