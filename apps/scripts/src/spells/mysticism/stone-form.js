import { aura, broadcastEffect, broadcastSound, broadcastBodyChange, skillValue } from '../_helpers.js';
// Audit #38 P1 #1 — Stone Form full mechanics. ServUO
// `StoneForm.DoEffect`:
//   resBonus = max(2, min(8, (Mys + max(Focus, Imbuing))/24))  → all five
//   dmgBonus = (Mys + sec)/12
//   poison immunity (CheckImmunity short-circuits applyPoison)
//   walk-only (no run)
//   -10 stam-regen / -2 dex-regen (omitted — minor)
// Was: body swap only. Strangle's `target._stoneForm` reader (#36)
// never tripped because nobody set the flag.
export default {
  name: 'stone-form', school: 'mysticism', circle: 4, mana: 11,
  cast(api, ctx) {
    const m = ctx.sender;
    if (m._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    m._origBody = m.body; m.body = 0x2EE;
    const mys = skillValue(m, 56);
    const sec = Math.max(skillValue(m, 51), skillValue(m, 57));
    const resBonus = Math.max(2, Math.min(8, Math.floor((mys + sec) / 24)));
    const dmgBonus = Math.floor((mys + sec) / 12);
    // Merge resist overlay (additive, same pattern as Reactive Armor / MR).
    const prior = m._resistOverlay ?? {};
    m._resistOverlay = {
      physical: (prior.physical | 0) + resBonus,
      fire:     (prior.fire     | 0) + resBonus,
      cold:     (prior.cold     | 0) + resBonus,
      poison:   (prior.poison   | 0) + resBonus,
      energy:   (prior.energy   | 0) + resBonus,
    };
    m._resBagDirty = true;
    m._stoneForm = true;
    m._stoneFormDmgBonus = dmgBonus;
    m._stoneFormWalkOnly = true;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x3779, hue: 0x90 }));
    broadcastSound(api, api.world, m, 0x65C);
    broadcastBodyChange(api, api.world, m);
    api.statusEffects?.apply?.(m, {
      name: 'stone-form', durationMs: 120_000,
      onRemove(mob) {
        if (mob._origBody == null) return;
        mob.body = mob._origBody;
        delete mob._origBody;
        broadcastBodyChange(api, api.world, mob);
        mob._stoneForm = false;
        mob._stoneFormDmgBonus = 0;
        mob._stoneFormWalkOnly = false;
        // Roll back the overlay delta.
        const cur = mob._resistOverlay ?? {};
        mob._resistOverlay = {
          physical: (cur.physical | 0) - resBonus,
          fire:     (cur.fire     | 0) - resBonus,
          cold:     (cur.cold     | 0) - resBonus,
          poison:   (cur.poison   | 0) - resBonus,
          energy:   (cur.energy   | 0) - resBonus,
        };
        const o = mob._resistOverlay;
        if (!o.physical && !o.fire && !o.cold && !o.poison && !o.energy) {
          mob._resistOverlay = null;
        }
        mob._resBagDirty = true;
      },
    });
  },
};
