import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
const RADIUS = 4;
export default {
  name: 'wildfire', school: 'spellweaving', circle: 6, mana: 50,
  cast(api, ctx, picked) {
    if (!picked) return ctx.state.sendSystemMessage('Wildfire cancelled.');
    const caster = ctx.sender;
    const sw = skillValue(caster, 55);
    const dmg = 18 + Math.floor(sw / 8);
    broadcastEffect(api, api.world, picked, aura(api, picked, { itemId: 0x4063, hue: 0x4C, duration: 60 }));
    broadcastSound(api, api.world, picked, 0x5CF);
    let hits = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      api.combat.damage(api.world, m, dmg, caster); hits++;
    }
    ctx.state.sendSystemMessage(`Wildfire ravages ${hits} foe(s).`);
  },
};
