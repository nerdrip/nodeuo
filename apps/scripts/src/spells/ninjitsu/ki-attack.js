import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Powerful single strike with bonus damage. Tag only.
export default {
  name: 'ki-attack', school: 'ninjitsu', circle: 1, mana: 5,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x37CC, hue: 0x47E }));
    broadcastSound(api, api.world, m, 0x21A);
    api.statusEffects?.apply?.(m, { name: 'ki-attack', durationMs: 20_000 });
  },
};
