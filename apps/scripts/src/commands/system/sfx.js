// [sfx <id> [name] — admin sound tester. Plays a UO sound effect for
// the issuing GM (lookup either by hex id or by SFX_NAMES catalog key)
// + optional broadcast to all in range.
//
//   [sfx 0x208           — single id, self only
//   [sfx COMBAT_HIT_SWORD — by name
//   [sfx 0x208 broadcast — fan-out to nearby clients (radius 18)

import { SFX, SFX_NAMES, sfxId } from '../../data/config/sfx-table.js';
import { sendToClientsNear } from '../../_spatial.js';

export default function register(api) {
  if (!api.commands || !api.protocol?.playSound) return () => {};

  api.commands.register({
    name: 'sfx',
    help: '[sfx <id|name> [broadcast] — preview a sound effect.',
    access: 'GM',
    run(ctx, args) {
      const sender = ctx.sender;
      if (!sender) return;
      const arg0 = args?.[0];
      if (!arg0) {
        ctx.state.sendSystemMessage(`Known SFX names: ${SFX_NAMES.length}. Use [sfx list to enumerate.`);
        return;
      }
      if (arg0.toLowerCase() === 'list') {
        const offset = parseInt(args?.[1], 10) || 0;
        for (const n of SFX_NAMES.slice(offset, offset + 30)) {
          ctx.state.sendSystemMessage(`  ${n.padEnd(28)} 0x${SFX[n].toString(16).padStart(4, '0')}`);
        }
        if (SFX_NAMES.length > offset + 30) {
          ctx.state.sendSystemMessage(`  …(${SFX_NAMES.length - offset - 30} more — [sfx list ${offset + 30})`);
        }
        return;
      }
      const id = arg0.startsWith('0x')
        ? parseInt(arg0, 16)
        : sfxId(arg0);
      if (!Number.isFinite(id) || id <= 0) {
        ctx.state.sendSystemMessage(`Unknown sound: ${arg0}`);
        return;
      }
      const broadcast = (args?.[1] ?? '').toLowerCase() === 'broadcast';
      const pkt = api.protocol.playSound({
        soundId: id, x: sender.x, y: sender.y, z: sender.z,
      });
      if (broadcast) {
        sendToClientsNear(api, sender, pkt);
        ctx.state.sendSystemMessage(`Broadcast SFX 0x${id.toString(16)}.`);
      } else {
        ctx.state.send?.(pkt);
        ctx.state.sendSystemMessage(`Played SFX 0x${id.toString(16)}.`);
      }
    },
  });
  return () => {};
}
