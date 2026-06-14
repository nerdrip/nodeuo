// Momentum Strike — single attack that hits 2 adjacent enemies.
// MVP: damage primary target + 1 nearby hostile.
import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
export default {
  name: 'momentum-strike', school: 'bushido', circle: 2, mana: 10,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Momentum Strike needs a target.');
    const caster = ctx.sender;
    const dmg = 12 + Math.floor(skillValue(caster, 53) / 10);
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
    // Find a second nearby hostile.
    for (const m of mobilesNear(api, target, 1)) {
      if (m === target || m === caster) continue;
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      api.combat.damage(api.world, m, dmg, caster);
      break;
    }
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x37C4, hue: 0x4F9 }));
    broadcastSound(api, api.world, target, 0x028B);
  },
};
