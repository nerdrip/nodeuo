// Horrific Beast — ServUO transformation: body 746 (0x2EA), stronger
// unarmed attacks, +25% weapon damage and +20 hit regeneration.
import { aura, broadcastEffect, broadcastSound, broadcastBodyChange } from '../_helpers.js';
const BEAST_BODY = 0x02EA;
const DURATION_MS = 60_000;
export default {
  name: 'horrific-beast', school: 'necromancy', circle: 4, mana: 11,
  cast(api, ctx) {
    const caster = ctx.sender;
    if (caster._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    caster._origBody = caster.body;
    caster.body = BEAST_BODY;
    caster.horrificBeastUntil = Date.now() + DURATION_MS;
    caster._horrificDamageBonus = 25;
    caster._horrificHpRegen = 20;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x3779, hue: 0x70 }));
    broadcastSound(api, api.world, caster, 0x0165);
    broadcastBodyChange(api, api.world, caster);
    api.statusEffects?.apply?.(caster, {
      name: 'horrific-beast', durationMs: DURATION_MS,
      onRemove(mob) {
        if (mob._origBody != null) {
          mob.body = mob._origBody;
          delete mob._origBody;
          broadcastBodyChange(api, api.world, mob);
        }
        mob.horrificBeastUntil = 0;
        mob._horrificDamageBonus = 0;
        mob._horrificHpRegen = 0;
      },
    });
  },
};
