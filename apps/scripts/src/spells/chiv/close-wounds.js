// Close Wounds — Chivalry heal (single target). No reagents; the shared
// spell registry charges the Chivalry tithing-point cost before effect.
// Heal amount scales with Chivalry skill so a low-Chiv paladin gets a
// modest patch and a maxed one gets a real heal.

import { aura, broadcastEffect, broadcastSound, healthUpdateFor, skillValue } from '../_helpers.js';
import { flagBeneficialOnCriminal } from '../../_notoriety.js';

export default {
  name: 'close-wounds',
  school: 'chivalry',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Close Wounds needs a target.');
      return;
    }
    // Audit #41 P2 #16 — ServUO `CloseWounds.cs:67-86` gates: range ≤2,
    // animated-dead refuse, poisoned OR Mortal-Struck refuse. Was: any
    // tile, ignored both states.
    if (target.map !== caster.map
        || Math.max(Math.abs(target.x - caster.x), Math.abs(target.y - caster.y)) > 2) {
      ctx.state.sendSystemMessage('That target is too far away.');
      return;
    }
    if (target._animatedDead) {
      ctx.state.sendSystemMessage('You cannot heal that.');
      return;
    }
    if (target.poisoned || (target._mortalStrikeUntil ?? 0) > Date.now()) {
      ctx.state.sendSystemMessage('You cannot heal that target in their current state.');
      return;
    }
    const chiv = skillValue(caster, 52);
    const heal = 8 + Math.floor(chiv / 5); // 8..32
    target.hp = Math.min(target.hpMax ?? 50, (target.hp ?? 0) + heal);
    try { flagBeneficialOnCriminal(api, caster, target); } catch { /* test stubs */ }
    api.combat.animate(api.world, caster, 0x11);
    const fx = aura(api, target, { itemId: 0x376A, hue: 0x4FE });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x202);
    if (target.client) target.client.send(healthUpdateFor(api, target));
    ctx.state.sendSystemMessage(`You heal ${target.name ?? 'the target'} for ${heal}.`);
  },
};
