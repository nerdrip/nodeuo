// Counter Attack — until next swing, parries auto-counter. Tag only.
import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
export default {
  name: 'counter-attack', school: 'bushido', circle: 1, mana: 5,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x37C4, hue: 0x44 }));
    broadcastSound(api, api.world, m, 0x028E);
    api.statusEffects?.apply?.(m, { name: 'counter-attack', durationMs: 30_000 });
  },
};
