import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Boost spell damage temporarily. Tag.
export default {
  name: 'arcane-empowerment', school: 'spellweaving', circle: 5, mana: 50,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x47E }));
    broadcastSound(api, api.world, m, 0x5BB);
    api.statusEffects?.apply?.(m, { name: 'arcane-empowerment', durationMs: 30_000 });
  },
};
