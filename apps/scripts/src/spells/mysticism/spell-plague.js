// Spell Plague — chained DoT debuff. MVP tag with a 3-tick onTick.
import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
export default {
  name: 'spell-plague', school: 'mysticism', circle: 7, mana: 40,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Spell Plague needs a target.');
    const caster = ctx.sender;
    const mysticism = skillValue(caster, 56);
    const perTick = 8 + Math.floor(mysticism / 12);
    let ticksLeft = 3;
    api.statusEffects?.apply?.(target, {
      name: 'spell-plague', durationMs: 6_500, tickIntervalMs: 2_000,
      onTick(mob) { if (--ticksLeft < 0) return; if ((mob.hp ?? 0) > 0) api.combat.damage(api.world, mob, perTick, caster); },
    });
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x36CB, hue: 0x4D }));
    broadcastSound(api, api.world, target, 0x658);
  },
};
