// Death Strike — Ninjitsu delayed-damage ability. The struck target
// takes a chunk of damage 5 seconds later, which doubles if they take
// any other damage in that window (ServUO `DeathStrike.cs`).
//
// MVP: just schedule the delayed tick via status-effects (single onTick
// at the end of duration). The "extra damage on movement" rider is
// FAZA Q part 2.

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';

export default {
  name: 'death-strike',
  school: 'ninjitsu',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Death Strike needs a target.');
      return;
    }
    const fx = aura(api, target, { itemId: 0x37CC, hue: 0x49, duration: 30 });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x21F);

    const ninjitsu = skillValue(caster, 54);
    const dmg = 12 + Math.floor(ninjitsu / 8); // 12..27
    setTimeout(() => {
      if ((target.hp ?? 0) <= 0) return;
      api.combat.damage(api.world, target, dmg, caster);
      api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
      if (target.client) target.client.sendSystemMessage('A killing blow lands on your back.');
    }, 5000);
    ctx.state.sendSystemMessage('Your Death Strike is set.');
  },
};
