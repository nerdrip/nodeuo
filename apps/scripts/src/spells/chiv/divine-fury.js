// Divine Fury — Chivalry self-buff. Boosts swing speed at the cost of
// stamina. MVP: applies a status-effect tag + a one-time stamina drain.
// The combat-formulas swingDelay can later read the buff to halve delay.

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';

export default {
  name: 'divine-fury',
  school: 'chivalry',
  cast(api, ctx) {
    const caster = ctx.sender;
    caster.stam = Math.max(0, (caster.stam ?? 0) - 10);
    if (caster.client) {
      caster.client.send(api.protocol.staminaUpdate({
        serial: caster.serial, current: caster.stam, max: caster.stamMax ?? 50,
      }));
    }
    const fx = aura(api, caster, { itemId: 0x37C4, hue: 0x4F6 });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x20F);
    const chiv = skillValue(caster, 52);
    const durationMs = 8_000 + chiv * 80;
    api.statusEffects?.apply?.(caster, { name: 'divine-fury', durationMs });
    ctx.state.sendSystemMessage('You are filled with divine fury.');
  },
};
