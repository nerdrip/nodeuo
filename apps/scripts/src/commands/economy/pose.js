// `[pose <id>` — re-pose a Mannequin (in-house statue).
//
// 0 = standing | 1 = warmode | 2 = sitting | 3 = lying
//
// Targets the mannequin first; ACL-gated (must be Friend+ on the
// house, OR the original placer).

import { setMannequinPose } from '../../items/scripts/functional/mannequin.js';
import { mobileBySerial } from '../../_entities.js';

export default function register(api) {
  if (!api.commands || !api.targeting?.request) return () => {};
  api.commands.register({
    name: 'pose',
    help: '[pose <id> — re-pose a Mannequin (0=stand 1=war 2=sit 3=lie).',
    access: 'Player',
    run(ctx) {
      const poseId = parseInt(ctx.args[0] ?? '0', 10) | 0;
      ctx.state.sendSystemMessage?.('Target the mannequin.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const mob = mobileBySerial(api, picked.serial >>> 0);
        if (!mob?._mannequin) {
          ctx.state.sendSystemMessage?.('That is not a mannequin.');
          return;
        }
        const r = setMannequinPose(api, ctx.sender, mob, poseId);
        if (!r.ok) {
          ctx.state.sendSystemMessage?.(`Cannot pose: ${r.reason}.`);
          return;
        }
        ctx.state.sendSystemMessage?.(`Pose set to ${poseId}.`);
      });
    },
  });
  return () => api.commands.unregister('pose');
}
