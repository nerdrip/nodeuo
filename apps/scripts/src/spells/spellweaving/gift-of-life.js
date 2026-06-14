import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Tag a friendly target with a self-resurrect-on-death flag.
export default {
  name: 'gift-of-life', school: 'spellweaving', circle: 5, mana: 70,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Gift of Life needs a target.');
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x376A, hue: 0x4FE }));
    broadcastSound(api, api.world, target, 0x5C8);
    api.statusEffects?.apply?.(target, { name: 'gift-of-life', durationMs: 60 * 60 * 1000 });
  },
};
