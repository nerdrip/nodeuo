import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
const RADIUS = 5;
export default {
  name: 'nether-cyclone', school: 'mysticism', circle: 8, mana: 50,
  cast(api, ctx, picked) {
    if (!picked) return ctx.state.sendSystemMessage('Nether Cyclone cancelled.');
    const caster = ctx.sender;
    const dmg = 26 + Math.floor(skillValue(caster, 56) / 6);
    broadcastEffect(api, api.world, picked, aura(api, picked, { itemId: 0x36CB, hue: 0x47E, duration: 40 }));
    broadcastSound(api, api.world, picked, 0x65F);
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      api.combat.damage(api.world, m, dmg, caster);
      m.mana = Math.max(0, (m.mana ?? 0) - 5);
    }
  },
};
