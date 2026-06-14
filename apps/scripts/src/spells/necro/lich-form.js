// Lich Form — Necromancy self-transform. ServUO `LichForm.cs:41-87`:
//   body = 749 (0x2ED, Lich), NOT 0x18 (was a wrong port-time pick).
//   resist mods: -10 fire, +10 cold, +10 poison
//   tick: `--m.Hits` every 2 s (60 HP drain over 120 s duration)
//   passive +13 mana regen (omitted — minor)
import { aura, broadcastEffect, broadcastSound, broadcastBodyChange } from '../_helpers.js';
export default {
  name: 'lich-form', school: 'necromancy', circle: 6, mana: 23,
  cast(api, ctx) {
    const caster = ctx.sender;
    if (caster._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    caster._origBody = caster.body;
    // Audit #38 P2 #9 — canonical Lich body 0x2ED. Was 0x18 — visually
    // a "low-detail" body number, not the lich.
    caster.body = 0x2ED;
    // Resist overlay merge — same pattern as Reaper Form / Stone Form.
    const prior = caster._resistOverlay ?? {};
    caster._resistOverlay = {
      physical: (prior.physical | 0),
      fire:     (prior.fire     | 0) - 10,
      cold:     (prior.cold     | 0) + 10,
      poison:   (prior.poison   | 0) + 10,
      energy:   (prior.energy   | 0),
    };
    caster._resBagDirty = true;
    caster.lichFormUntil = Date.now() + 120_000;     // regen.js reader stamp
    caster._lichDrainAt  = 0;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x3779, hue: 0x47E }));
    broadcastSound(api, api.world, caster, 0x0166);
    broadcastBodyChange(api, api.world, caster);
    api.statusEffects?.apply?.(caster, {
      name: 'lich-form', durationMs: 120_000,
      onRemove(mob) {
        if (mob._origBody == null) return;
        mob.body = mob._origBody;
        delete mob._origBody;
        broadcastBodyChange(api, api.world, mob);
        mob.lichFormUntil = 0;
        mob._lichDrainAt  = 0;
        // Roll back the overlay deltas.
        const cur = mob._resistOverlay ?? {};
        mob._resistOverlay = {
          physical: (cur.physical | 0),
          fire:     (cur.fire     | 0) + 10,
          cold:     (cur.cold     | 0) - 10,
          poison:   (cur.poison   | 0) - 10,
          energy:   (cur.energy   | 0),
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
