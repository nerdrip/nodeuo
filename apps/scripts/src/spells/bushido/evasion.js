// Evasion — perfect-parry buff for 7 seconds. Tag only; combat-formulas
// would consult the buff to force a parry result.
import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
export default {
  name: 'evasion', school: 'bushido', circle: 2, mana: 10,
  cast(api, ctx) {
    const m = ctx.sender;
    // Audit #42 P2 #15 — ServUO `Evasion.cs:130-151`:
    //   duration_s = 3 + (Bushido-60)/20  (+1 if Anat ≥100 AND Tactics ≥100 AND Bushido>100)
    //   parry_scalar = 1.16 + (Bushido-60) * 0.004   (clamps to ~1.50 at GM)
    // Reader: `_evasionUntil` + `_evasionParryScalar` consumed in
    // combat-formulas `hitChance()` to multiply defender parry chance.
    // Was: flat 7s with no scalar — purely cosmetic.
    const bushido = skillValue(m, 53);
    const anat    = skillValue(m, 2);
    const tactics = skillValue(m, 28);
    let durationSec = 3 + Math.max(0, (bushido - 60)) / 20;
    if (anat >= 100 && tactics >= 100 && bushido > 100) durationSec += 1;
    durationSec = Math.max(3, Math.min(7, durationSec));
    const scalar = Math.min(1.50, 1.16 + Math.max(0, (bushido - 60)) * 0.004);
    m._evasionUntil = Date.now() + Math.floor(durationSec * 1000);
    m._evasionParryScalar = scalar;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x375A, hue: 0x49 }));
    broadcastSound(api, api.world, m, 0x020A);
    api.statusEffects?.apply?.(m, {
      name: 'evasion',
      durationMs: Math.floor(durationSec * 1000),
      onRemove(mob) { mob._evasionUntil = 0; mob._evasionParryScalar = 1; },
    });
  },
};
