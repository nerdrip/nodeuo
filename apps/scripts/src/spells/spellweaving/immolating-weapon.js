import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
export default {
  name: 'immolating-weapon', school: 'spellweaving', circle: 2, mana: 32,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x36BD, hue: 0x4C }));
    broadcastSound(api, api.world, m, 0x5C3);
    api.statusEffects?.apply?.(m, { name: 'immolating-weapon', durationMs: 30_000 });
  },
};
