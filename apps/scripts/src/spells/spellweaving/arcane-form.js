import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';

// Arcane Form — port of ServUO `ArcaneForm.cs`. Briefly empowers
// the caster's magery / mysticism casts. Implementation parity:
//   • +10 SpellDamageIncrease for 60s
//   • +5 LowerManaCost for 60s
//   • visual: silver-blue aura + arcane chime
// Reagents: Bloodmoss + Ginseng + MandrakeRoot per ServUO recipe.

export default {
  name: 'arcane-form', school: 'spellweaving', circle: 1, mana: 14,
  cast(api, ctx) {
    const m = ctx.sender;
    if (m._arcaneFormUntil && m._arcaneFormUntil > Date.now()) {
      ctx.state.sendSystemMessage('You are already in arcane form.');
      return;
    }
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x4D2 }));
    broadcastSound(api, api.world, m, 0x5BB);
    const duration = 60_000;
    m._arcaneFormUntil = Date.now() + duration;
    m._arcaneFormSDI = 10;
    m._arcaneFormLMC = 5;
    api.statusEffects?.apply?.(m, {
      name: 'arcane-form', durationMs: duration,
      onRemove(mob) {
        mob._arcaneFormSDI = 0;
        mob._arcaneFormLMC = 0;
        delete mob._arcaneFormUntil;
      },
    });
  },
};
