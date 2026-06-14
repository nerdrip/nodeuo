import { aura, broadcastEffect, broadcastSound, healthUpdateFor, skillValue } from '../_helpers.js';
export default {
  name: 'healing-stone', school: 'mysticism', circle: 1, mana: 4,
  cast(api, ctx) {
    const m = ctx.sender;
    const heal = 10 + Math.floor(skillValue(m, 56) / 6);
    m.hp = Math.min(m.hpMax ?? 50, (m.hp ?? 0) + heal);
    if (m.client) m.client.send(healthUpdateFor(api, m));
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x4078, hue: 0x4FE }));
    broadcastSound(api, api.world, m, 0x65A);
  },
};
