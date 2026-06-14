import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
// Audit #37 P2 #3 — ServUO `HailStormSpell.cs:39-95`:
//   radius 2 (was 4); damage `GetNewAosDamage(51, 1, 5)` (~30..50);
//   when >2 targets caught, dmg = dmg*2/count (cap the spread DPS).
// Was: radius 4, flat `18 + mys/8`, no count-divisor — high-density
// mob packs took massive damage per cast.
const RADIUS = 2;
export default {
  name: 'hail-storm', school: 'mysticism', circle: 7, mana: 40,
  cast(api, ctx, picked) {
    if (!picked) return ctx.state.sendSystemMessage('Hail Storm cancelled.');
    const caster = ctx.sender;
    const mys = skillValue(caster, 56);
    let dmg = 18 + Math.floor(mys / 8);
    // Pre-pass to count targets so the divisor applies uniformly.
    const targets = [];
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      targets.push(m);
    }
    if (targets.length > 2) dmg = Math.floor(dmg * 2 / targets.length);
    broadcastEffect(api, api.world, picked, aura(api, picked, { itemId: 0x36CB, hue: 0x47, duration: 30 }));
    broadcastSound(api, api.world, picked, 0x64F);
    for (const m of targets) api.combat.damage(api.world, m, dmg, caster);
    ctx.state.sendSystemMessage(`Hail batters ${targets.length}.`);
  },
};
