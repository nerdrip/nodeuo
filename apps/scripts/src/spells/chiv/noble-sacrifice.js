// Noble Sacrifice — caster surrenders most HP to fully heal nearby
// allies + resurrect any ghost in range. The classic Chivalry "save
// the party" panic button.
import { aura, broadcastEffect, broadcastSound, broadcastHealthUpdate, mobilesNear } from '../_helpers.js';
const RADIUS = 5;
export default {
  name: 'noble-sacrifice', school: 'chivalry', circle: 6, mana: 0,
  cast(api, ctx) {
    const caster = ctx.sender;
    if ((caster.hp ?? 0) < 30) return ctx.state.sendSystemMessage('You are too weak to make the sacrifice.');
    caster.hp = Math.max(1, Math.floor((caster.hp ?? 0) * 0.2));
    // BUGFIX #69 (PHASE DA): broadcast caster's HP drop so observers'
    // bars register the sacrifice immediately.
    broadcastHealthUpdate(api, api.world, caster);
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x376A, hue: 0x4FE, duration: 40 }));
    broadcastSound(api, api.world, caster, 0x0214);
    let healed = 0, raised = 0;
    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      const noto = m.notoriety ?? 1;
      if (noto !== 1 && noto !== 2) continue;
      if (m.ghost) {
        api.corpse?.resurrectMobile?.(api.world, m); raised++;
      } else if ((m.hp ?? 0) > 0) {
        m.hp = m.hpMax ?? 50;
        // BUGFIX #69: observers must see the heal too.
        broadcastHealthUpdate(api, api.world, m);
        healed++;
      }
    }
    ctx.state.sendSystemMessage(`Sacrifice: ${healed} healed, ${raised} resurrected.`);
  },
};
