// Vengeful Spirit — sends a vengeful ghost to attack a target. MVP:
// summon a hostile-mode skeleton near the target with the target as
// initial focus.
import { broadcastSound } from '../_helpers.js';
export default {
  name: 'vengeful-spirit', school: 'necromancy', circle: 7, mana: 41,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Vengeful Spirit needs a target.');
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Spirit summoning unavailable.');
    const spirit = factory(api.world, 'skeleton', { x: target.x + 1, y: target.y, z: target.z, map: target.map });
    if (!spirit) return ctx.state.sendSystemMessage('The spirit fails to manifest.');
    spirit.notoriety = 5; // hostile
    api.ai?.attach?.(spirit, 'aggressive', { kind: 'skeleton', targetSerial: target.serial });
    broadcastSound(api, api.world, target, 0x217);
    ctx.state.sendSystemMessage('A vengeful spirit rises.');
  },
};
