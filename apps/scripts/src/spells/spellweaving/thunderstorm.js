import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
const RADIUS = 5;
export default {
  name: 'thunderstorm', school: 'spellweaving', circle: 4, mana: 32,
  cast(api, ctx) {
    const caster = ctx.sender;
    const sw = skillValue(caster, 55);
    const dmg = 14 + Math.floor(sw / 10);
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x36CB, hue: 0x4D, duration: 30 }));
    broadcastSound(api, api.world, caster, 0x5CE);
    let hits = 0;
    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      api.combat.damage(api.world, m, dmg, caster); hits++;
    }
    ctx.state.sendSystemMessage(`Thunderstorm strikes ${hits} foe(s).`);
  },
};
