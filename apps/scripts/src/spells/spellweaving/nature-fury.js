// Nature's Fury — projects a swarm of insects at a target.
import { broadcastEffect, broadcastSound, projectile, skillValue } from '../_helpers.js';
export default {
  name: 'nature-fury', school: 'spellweaving', circle: 2, mana: 24,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Nature\'s Fury needs a target.');
    const caster = ctx.sender;
    const dmg = 10 + Math.floor(skillValue(caster, 55) / 12);
    broadcastEffect(api, api.world, caster, projectile(api, caster, target, { itemId: 0x91B, hue: 0x4F2 }));
    broadcastSound(api, api.world, target, 0x5C9);
    // BUGFIX #99 (FAZA EE): pass caster so the damage path can apply
    // young-PK guard + stealth break-on-attack + honor multiplier.
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
  },
};
