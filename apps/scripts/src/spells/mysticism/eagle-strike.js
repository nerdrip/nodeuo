import { broadcastEffect, broadcastSound, projectile, skillValue } from '../_helpers.js';
export default {
  name: 'eagle-strike', school: 'mysticism', circle: 3, mana: 9,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Eagle Strike needs a target.');
    const caster = ctx.sender;
    const dmg = 12 + Math.floor(skillValue(caster, 56) / 8);
    broadcastEffect(api, api.world, caster, projectile(api, caster, target, { itemId: 0x91B, hue: 0x49E }));
    broadcastSound(api, api.world, target, 0x652);
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
  },
};
