import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Next swing crits if hidden. Tag only.
export default {
  name: 'focus-attack', school: 'ninjitsu', circle: 1, mana: 5,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x37CC, hue: 0x42 }));
    broadcastSound(api, api.world, m, 0x21A);
    api.statusEffects?.apply?.(m, { name: 'focus-attack', durationMs: 30_000 });
  },
};
