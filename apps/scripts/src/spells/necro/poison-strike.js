// Poison Strike — Necro AOE: target takes the brunt, splashes 50% to
// nearby hostiles. Mirrors ServUO PoisonStrikeSpell.cs.
import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
const RADIUS = 2;
export default {
  name: 'poison-strike', school: 'necromancy', circle: 3, mana: 17,
  // Audit #41 P2 #26 — ServUO `PoisonStrikeSpell.cs` deals 100% poison
  // damage. Was: untyped (default physical) so naked-phys-resist
  // victims took the full hit while their poison resist did nothing.
  damageType: { poison: 100 },
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Poison Strike needs a target.');
    const caster = ctx.sender;
    const necro = skillValue(caster, 50);
    const baseDmg = 14 + Math.floor(necro / 10);
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x36B0, hue: 0x46 }));
    broadcastSound(api, api.world, target, 0x0205);
    api.combat.damage(api.world, target, baseDmg, caster, this.damageType);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
    for (const m of mobilesNear(api, target, RADIUS)) {
      if (m === target || m === caster) continue;
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1;
      if (noto === 1 || noto === 2) continue;
      api.combat.damage(api.world, m, baseDmg >> 1, caster, this.damageType);
    }
  },
};
