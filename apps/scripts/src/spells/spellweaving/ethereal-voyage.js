import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Brief invulnerability buff. Tag only.
export default {
  name: 'ethereal-voyage', school: 'spellweaving', circle: 4, mana: 32,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x4F }));
    broadcastSound(api, api.world, m, 0x5C0);
    api.statusEffects?.apply?.(m, { name: 'ethereal-voyage', durationMs: 6_000 });
  },
};
