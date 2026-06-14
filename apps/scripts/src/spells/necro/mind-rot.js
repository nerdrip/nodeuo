// Mind Rot — increases the target's mana cost on every spell cast for
// the duration. The server spell dispatcher reads `_mindRotUntil` and
// applies the +50% mana surcharge on every cast path.
import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
export default {
  name: 'mind-rot', school: 'necromancy', circle: 3, mana: 17,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Mind Rot needs a target.');
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x3728, hue: 0x05 }));
    broadcastSound(api, api.world, target, 0x021F);
    // Mark for cast.js to read — every spell the target casts during
    // the buff window pays +50 % mana cost. ServUO MindRot duration
    // 25 s @ skill 60 (scales with caster Necromancy).
    target._mindRotUntil = Date.now() + 25_000;
    api.statusEffects?.apply?.(target, { name: 'mind-rot', durationMs: 25_000 });
    target.client?.sendSystemMessage?.('Your thoughts feel sluggish.');
  },
};
