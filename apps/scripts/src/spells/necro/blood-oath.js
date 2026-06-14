// Blood Oath — bind target so a portion of damage they deal reflects to
// them. Tagged via status-effects. Combat code checks the flag on hit.
import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
export default {
  name: 'blood-oath', school: 'necromancy', circle: 2, mana: 13,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Blood Oath needs a target.');
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x375A, hue: 0x44 }));
    broadcastSound(api, api.world, target, 0x0204);
    const necro = skillValue(ctx.sender, 50);
    api.statusEffects?.apply?.(target, {
      name: 'blood-oath', durationMs: 6_000 + necro * 200, data: { caster: ctx.sender.serial },
    });
  },
};
