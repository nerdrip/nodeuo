// Arcane Circle — gathers nearby spellweavers to amplify spells.
// Sets `_arcaneFocus` on the caster (1..5 = number of nearby
// spellweavers + 1 for the caster). `applySpellDamage` reads this
// to multiply damage. ServUO `ArcaneCircleSpell.OnCast` formula:
//   focus = 1 + min(4, nearby spellweaver allies within 8 tiles)
//   damage_mul = 1 + focus * 0.05   // +5..25 %
import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';

// Audit #41 P1 #7 — Spellweaving is skill id 55 (skills.json:56);
// id 56 is Mysticism. The prior fix flipped the wrong way and the
// circle was counting Mystics — so a Mystic party gave focus×3 while
// real Spellweavers gave 1. ServUO `ArcaneCircleSpell` counts SW ≥ 0.
const SKILL_SPELLWEAVING = 55;

export default {
  name: 'arcane-circle', school: 'spellweaving', circle: 1, mana: 24,
  cast(api, ctx) {
    const m = ctx.sender;
    // Count nearby spellweavers (Spellweaving >= 25). Sector-aware
    // fan-out — was a full 11.7k mobile walk per cast.
    let focus = 1;
    for (const o of mobilesNear(api, m, 8, m)) {
      // Audit #41 P1 #7 — skills are 0..120 fixed-point, never 250.
      // ServUO `ArcaneCircleSpell` counts any nearby SW ≥ 0 (>0 for
      // participation). Use 25 as a sensible "actual spellweaver"
      // floor (a complete novice still counts).
      if (skillValue(o, SKILL_SPELLWEAVING) >= 25) {
        focus++;
        if (focus >= 5) break;
      }
    }
    // Audit #37 P1 #1 — canonical field name is `_arcaneFocusLevel`
    // (also on persistence whitelist + read by `systems/spellweaving.js`
    // for mana cost). Previously we set `_arcaneFocus` here while the
    // mana-cost reader looked at `_arcaneFocusLevel` — the 10-min
    // ritual gave zero mana discount.
    m._arcaneFocusLevel = focus;
    m._arcaneFocus = focus;                       // legacy alias for `_helpers.js` damage reader
    m._arcaneFocusUntil = Date.now() + 600_000;   // 10 min
    // ServUO `ArcaneCircleSpell.AddArcaneFocus` also drops a wooden
    // Arcane Focus necklace into the caster's pack — physical token of
    // the buff. Without it third-party UO clients can't show the icon.
    if (api.game?.mobile?.giveItem && !m._arcaneFocusItem) {
      const it = api.game.mobile.giveItem(m, {
        itemId: 0x2A8F,
        hue: 0x489,
        name: 'arcane focus',
      }, { randomGrid: true });
      if (it) {
        it._arcaneFocusToken = true;
        m._arcaneFocusItem = it.serial;
      }
    }
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x44, duration: 30 }));
    broadcastSound(api, api.world, m, 0x590);
    api.statusEffects?.apply?.(m, { name: 'arcane-circle', durationMs: 600_000 });
    m.client?.sendSystemMessage?.(`The arcane focus surrounds you (×${focus}).`);
  },
};
