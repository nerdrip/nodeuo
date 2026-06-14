// Holy Light — Chivalry AOE radiant damage centred on the caster.
// Mirrors Dispel Evil but lower bar and any hostile takes damage
// (not just summoned/undead).
import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
// Audit #41 P2 #17 — ServUO `HolyLight.cs:74` uses radius 3.
const RADIUS = 3;
export default {
  name: 'holy-light', school: 'chivalry', circle: 4, mana: 0,
  cast(api, ctx) {
    const caster = ctx.sender;
    const chiv = skillValue(caster, 52);
    // Audit #41 P2 #17 — clamp damage to ServUO [8, 24] band.
    const baseDmg = Math.max(8, Math.min(24, 10 + Math.floor(chiv / 8) + Math.floor(Math.random() * 3)));
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x376A, hue: 0x4F2, duration: 30 }));
    broadcastSound(api, api.world, caster, 0x0210);
    let hits = 0;
    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1;
      if (noto === 1 || noto === 2) continue;
      api.combat.damage(api.world, m, baseDmg, caster);
      hits++;
    }
    ctx.state.sendSystemMessage(`Holy light burns ${hits} foe(s).`);
  },
};
