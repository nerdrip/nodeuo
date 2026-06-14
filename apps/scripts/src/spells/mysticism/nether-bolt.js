// Nether Bolt — Mysticism direct-damage spell, the school's analog to
// Magic Arrow. Damage scales with Mysticism + Imbuing/Focus (we ignore
// the focus skill for MVP — Mysticism alone drives the formula).

import { broadcastEffect, broadcastSound, projectile, skillValue } from '../_helpers.js';

export default {
  name: 'nether-bolt',
  school: 'mysticism',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Nether Bolt needs a target.');
      return;
    }
    const myst = skillValue(caster, 56);
    const dmg = 6 + Math.floor(Math.random() * 7) + Math.floor(myst / 25); // 6..16
    api.combat.animate(api.world, caster, 0x10);
    const fx = projectile(api, caster, target, { itemId: 0x36F4, hue: 0x49E });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, target, 0x211);
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
