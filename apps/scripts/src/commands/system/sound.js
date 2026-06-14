// `[sound <id>` — play a sound effect at the sender's location, broadcast to
// nearby clients.

import { sendToClientsNear } from '../../_spatial.js';

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.protocol) return () => {};

  api.commands.register({
    name: 'sound',
    help: '[sound <id> — play a sound effect. Try 0x19 (bell) or 0x52 (fire).',
    run(ctx, args) {
      if (!args.length) {
        ctx.state.sendSystemMessage('Usage: [sound <id>');
        return;
      }
      const id = parseInt(args[0], 0);
      if (!Number.isFinite(id) || id < 0 || id > 0xFFFF) {
        ctx.state.sendSystemMessage('Invalid sound id.');
        return;
      }
      const pkt = api.protocol.playSound({
        soundId: id, x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z,
      });
      sendToClientsNear(api, ctx.sender, pkt);
    },
  });

  return () => api.commands.unregister('sound');
}
