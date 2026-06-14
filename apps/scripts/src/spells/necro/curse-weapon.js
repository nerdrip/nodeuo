// Curse Weapon — Necromancy self-buff: caster's melee strikes drain HP
// from the victim into the caster. MVP: status-effect tag + small
// passive heal-on-hit handled in combat.tick when we wire it. Visual
// effect runs immediately.

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';

export default {
  name: 'curse-weapon',
  school: 'necromancy',
  cast(api, ctx) {
    const caster = ctx.sender;
    const fx = aura(api, caster, { itemId: 0x3779, hue: 0x047 });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x0387);
    // Audit #41 P1 #3 — SpiritSpeak is 33, not 32 (Archery).
    const ss    = skillValue(caster, 33);
    // ServUO CurseWeapon.cs:67 — `(SS / 3.4) + 1` seconds (~31s @ 100 SS).
    const seconds = ((ss / 3.4) + 1);
    const durationMs = Math.round(seconds * 1000);
    api.statusEffects?.apply?.(caster, {
      name: 'curse-weapon',
      durationMs,
    });
    ctx.state.sendSystemMessage('You curse your weapon with a thirst for blood.');
  },
};
