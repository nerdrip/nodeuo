// Honorable Execution — your next melee swing has bonus damage
// scaling with Bushido. Tag only; combat reads the flag on swing.
import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
export default {
  name: 'honorable-execution', school: 'bushido', circle: 1, mana: 0,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x37C4, hue: 0x4FE }));
    broadcastSound(api, api.world, m, 0x028B);
    api.statusEffects?.apply?.(m, { name: 'honorable-execution', durationMs: 20_000 });
  },
};
