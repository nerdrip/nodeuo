import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
// Audit #37 P1 #6 — ServUO `ReaperForm.DoEffect`:
//   resist offsets: +5 phys / +5 cold / +5 pois / +5 nrgy / -25 fire
//   SwingSpeedIncrease + 10
//   SpellDamageIncrease + 10
//   walk-only (no run) — enforced in the movement gate
// Was: body-swap only. Reaper-form was a 34-mana cosmetic.
export default {
  name: 'reaper-form', school: 'spellweaving', circle: 4, mana: 34,
  cast(api, ctx) {
    const m = ctx.sender;
    if (m._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    m._origBody = m.body; m.body = 0x4D;
    if (m.client && api.protocol?.mobileUpdate) m.client.send(api.protocol.mobileUpdate({
      serial: m.serial, body: m.body, hue: m.hue, flags: m.flags,
      x: m.x, y: m.y, z: m.z, direction: m.direction,
    }));
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x3779, hue: 0x4D }));
    broadcastSound(api, api.world, m, 0x5BC);
    // Resist overlay — merges with any prior overlay so Magic Reflect
    // / Reactive Armor stack additively. `effectiveResistance` reads
    // `_resistOverlay`; `_resBagDirty` forces a re-merge.
    const prior = m._resistOverlay ?? {};
    m._resistOverlay = {
      physical: (prior.physical | 0) + 5,
      fire:     (prior.fire     | 0) - 25,
      cold:     (prior.cold     | 0) + 5,
      poison:   (prior.poison   | 0) + 5,
      energy:   (prior.energy   | 0) + 5,
    };
    m._resBagDirty = true;
    m._reaperForm = true;
    m._reaperSSI = 10;       // combat-formulas swingDelayMs reader
    m._reaperSDI = 10;       // applySpellDamage reader
    m._reaperWalkOnly = true; // movement handler reader
    api.statusEffects?.apply?.(m, {
      name: 'reaper-form', durationMs: 90_000,
      onRemove(mob) {
        if (mob._origBody != null) { mob.body = mob._origBody; delete mob._origBody; }
        mob._reaperForm = false;
        mob._reaperSSI = 0;
        mob._reaperSDI = 0;
        mob._reaperWalkOnly = false;
        // Roll back the overlay deltas (reverse of the apply above).
        const cur = mob._resistOverlay ?? {};
        mob._resistOverlay = {
          physical: (cur.physical | 0) - 5,
          fire:     (cur.fire     | 0) + 25,
          cold:     (cur.cold     | 0) - 5,
          poison:   (cur.poison   | 0) - 5,
          energy:   (cur.energy   | 0) - 5,
        };
        // If the overlay is now all-zero, drop it entirely.
        const o = mob._resistOverlay;
        if (!o.physical && !o.fire && !o.cold && !o.poison && !o.energy) {
          mob._resistOverlay = null;
        }
        mob._resBagDirty = true;
      },
    });
  },
};
