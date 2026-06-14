import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
// Audit #37 P2 #5 — ServUO `EssenceOfWindSpell.cs:73-107`:
//   per-target: `FCMalus = focusLevel + 1` (slows cast),
//               `SSIMalus = 2 * (focusLevel + 1)` (slows swing)
//   duration: `skill/24 + focus` seconds (NOT flat 6 s)
//   CheckResisted gates per-target
// Combat readers (combat-formulas.js fasterCasting + swingSpeedIncrease
// already subtract `_essenceWindFCMalus` / `_essenceWindSSIMalus`).
const RADIUS = 5;
export default {
  name: 'essence-of-wind', school: 'spellweaving', circle: 5, mana: 40,
  cast(api, ctx) {
    const caster = ctx.sender;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x376A, hue: 0x47, duration: 40 }));
    broadcastSound(api, api.world, caster, 0x5C5);
    const sw = skillValue(caster, 55);
    const focus = (caster._arcaneFocusLevel | 0) || (caster._arcaneFocus | 0);
    const fcMalus = focus + 1;
    const ssiMalus = 2 * (focus + 1);
    const durSec = Math.max(2, Math.floor(sw / 24) + focus);
    let chilled = 0;
    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      // Per-target resist roll — high MR shrugs.
      const mr = skillValue(m, 27);
      if (Math.random() * 100 < mr * 0.6) continue;
      m._essenceWindFCMalus = fcMalus;
      m._essenceWindSSIMalus = ssiMalus;
      m._essenceWindUntil = Date.now() + durSec * 1000;
      api.statusEffects?.apply?.(m, {
        name: 'essence-of-wind',
        durationMs: durSec * 1000,
        onRemove(mob) {
          mob._essenceWindFCMalus = 0;
          mob._essenceWindSSIMalus = 0;
          mob._essenceWindUntil = 0;
        },
      });
      chilled++;
    }
    ctx.state.sendSystemMessage(`Wind chills ${chilled} foe(s).`);
  },
};
