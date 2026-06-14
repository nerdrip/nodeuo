// Consecrate Weapon — Chivalry self-buff. Briefly hallows the caster's
// weapon so its blows hit through resistances. MVP: tag a status-effect
// the combat code can read; visual + buff bar entry already broadcast
// via the existing status-effects listener.

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';

export default {
  name: 'consecrate-weapon',
  school: 'chivalry',
  cast(api, ctx) {
    const caster = ctx.sender;
    const fx = aura(api, caster, { itemId: 0x37C4, hue: 0x4FE });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x20C);
    // Audit #42 P2 #18 — ServUO `ConsecrateWeapon.cs:104-123` karma-
    // tiered duration:
    //   <1000  → 5s, <2000 → 6s, <3000 → 7s, <4000 → 8s, <5000 → 9s,
    //   <6000 → 10s, else 11s.
    // Plus `_consecrateProcChance` (100 if Chiv>=80 else Chiv) and
    // `_consecrateDmgBonus = (Chiv-90)/2` if Chiv>=90 — these stamp
    // for damage() to read on each hit (route weapon damage to defender's
    // weakest resist when proc rolls).
    const chiv = skillValue(caster, 52);
    const karma = caster.karma ?? 0;
    const kSec = karma < 1000 ? 5 : karma < 2000 ? 6 : karma < 3000 ? 7
              : karma < 4000 ? 8 : karma < 5000 ? 9 : karma < 6000 ? 10 : 11;
    const durationMs = kSec * 1000;
    caster._consecrateUntil = Date.now() + durationMs;
    caster._consecrateProcChance = chiv >= 80 ? 100 : chiv;
    caster._consecrateDmgBonus = chiv >= 90 ? Math.floor((chiv - 90) / 2) : 0;
    api.statusEffects?.apply?.(caster, {
      name: 'consecrate-weapon', durationMs,
      onRemove(mob) {
        mob._consecrateUntil = 0;
        mob._consecrateProcChance = 0;
        mob._consecrateDmgBonus = 0;
      },
    });
    ctx.state.sendSystemMessage('Your weapon is consecrated.');
  },
};
