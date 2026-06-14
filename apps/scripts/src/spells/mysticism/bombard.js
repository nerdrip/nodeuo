import { broadcastEffect, broadcastSound, projectile, skillValue } from '../_helpers.js';
export default {
  name: 'bombard', school: 'mysticism', circle: 6, mana: 20,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Bombard needs a target.');
    const caster = ctx.sender;
    const dmg = 22 + Math.floor(skillValue(caster, 56) / 6);
    broadcastEffect(api, api.world, caster, projectile(api, caster, target, { itemId: 0x4068, hue: 0x4D }));
    broadcastSound(api, api.world, target, 0x64D);
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
  },
};
