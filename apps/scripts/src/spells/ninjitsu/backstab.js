import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
import { reveal } from '../../_visibility.js';
// Devastating strike from stealth. Direct damage if hidden, else fizzles.
export default {
  name: 'backstab', school: 'ninjitsu', circle: 2, mana: 30,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Backstab needs a target.');
    const caster = ctx.sender;
    if (!caster.hidden) return ctx.state.sendSystemMessage('You must be hidden to backstab.');
    const dmg = 25 + Math.floor(skillValue(caster, 54) / 6);
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x37CC, hue: 0x46 }));
    broadcastSound(api, api.world, target, 0x21A);
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
    // Audit #41 P2 #23 — ServUO `Backstab.cs` strips Hidden +
    // RevealingAction after the strike. Was: caster stayed hidden and
    // could chain-backstab from full stealth. Re-broadcast via the
    // `reveal()` helper so observers also see them pop into view.
    try { reveal(api, caster); } catch { caster.hidden = false; }
  },
};
