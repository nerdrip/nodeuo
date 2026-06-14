// Horrific Beast — transform self into a beast (body 0x002C). MVP swaps
// the body and clears the buff after duration; resists/damage tweaks
// would come from per-form data not yet ported.
import { aura, broadcastEffect, broadcastSound, broadcastBodyChange } from '../_helpers.js';
const BEAST_BODY = 0x002C;
export default {
  name: 'horrific-beast', school: 'necromancy', circle: 4, mana: 11,
  cast(api, ctx) {
    const caster = ctx.sender;
    if (caster._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    caster._origBody = caster.body;
    caster.body = BEAST_BODY;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x3779, hue: 0x70 }));
    broadcastSound(api, api.world, caster, 0x0166);
    broadcastBodyChange(api, api.world, caster);
    api.statusEffects?.apply?.(caster, {
      name: 'horrific-beast', durationMs: 60_000,
      onRemove(mob) {
        if (mob._origBody == null) return;
        mob.body = mob._origBody;
        delete mob._origBody;
        broadcastBodyChange(api, api.world, mob);
      },
    });
  },
};
