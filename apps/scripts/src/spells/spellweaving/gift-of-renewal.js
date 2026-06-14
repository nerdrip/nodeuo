// Gift of Renewal — Spellweaving HoT (heal-over-time) spell. Targeted
// friendly mob receives a regen pulse every 2s for ~30s, scaling with
// the caster's Spellweaving + active Arcane Focus level.

import { aura, broadcastEffect, broadcastSound, healthUpdateFor, skillValue } from '../_helpers.js';

export default {
  name: 'gift-of-renewal',
  school: 'spellweaving',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Gift of Renewal needs a target.');
      return;
    }
    const fx = aura(api, target, { itemId: 0x376A, hue: 0x4F8, duration: 60 });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x29F);

    const sw = skillValue(caster, 55);
    const focusActive = (caster._arcaneFocusUntil ?? 0) > Date.now();
    const focus = focusActive ? Math.max(caster._arcaneFocusLevel | 0, caster._arcaneFocus | 0) : 0;
    const perTick = 4 + Math.floor(sw / 25) + Math.min(5, Math.max(0, focus)); // 4..13
    const tickIntervalMs = 2_000;
    let ticksLeft = 15;
    api.statusEffects?.apply?.(target, {
      name: 'gift-of-renewal',
      durationMs: tickIntervalMs * ticksLeft + 100,
      tickIntervalMs,
      onTick(mob) {
        if (--ticksLeft < 0) return;
        if ((mob.hp ?? 0) <= 0) return;
        mob.hp = Math.min(mob.hpMax ?? 50, (mob.hp ?? 0) + perTick);
        if (mob.client) mob.client.send(healthUpdateFor(api, mob));
      },
    });
    ctx.state.sendSystemMessage(`${target.name ?? 'The target'} is wreathed in renewing light.`);
  },
};
