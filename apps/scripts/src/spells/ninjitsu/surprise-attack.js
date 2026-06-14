import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Strike from stealth that ignores defender's parry. Tag only.
export default {
  name: 'surprise-attack', school: 'ninjitsu', circle: 1, mana: 5,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x37CC, hue: 0x44 }));
    broadcastSound(api, api.world, m, 0x21A);
    api.statusEffects?.apply?.(m, { name: 'surprise-attack', durationMs: 20_000 });
  },
};
