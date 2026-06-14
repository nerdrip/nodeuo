import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
export default {
  name: 'enchant', school: 'mysticism', circle: 2, mana: 8,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x4FE }));
    broadcastSound(api, api.world, m, 0x65B);
    api.statusEffects?.apply?.(m, { name: 'enchant', durationMs: 30_000 });
  },
};
