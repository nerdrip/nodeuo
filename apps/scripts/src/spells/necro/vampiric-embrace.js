// Vampiric Embrace — long-duration self-buff: melee strikes drain
// life into the caster. MVP tags the status; combat.js would read
// `vampiric-embrace` to add a heal-on-hit rider.
// ServUO `VampiricEmbrace.cs:41-91` is a full TransformationSpell:
// body swap (human 0x190/0x191 or Gargoyle 666/667), hue 0x847E,
// FireResistOffset -25, poison immunity at Necromancy > 99.
import { aura, broadcastEffect, broadcastSound, broadcastBodyChange, skillValue } from '../_helpers.js';

function vampiricBody(caster) {
  const female = caster.female === true || (caster.sex | 0) === 1
    || caster.body === 0x191 || caster.body === 0x29B;
  const gargoyle = caster.race === 'gargoyle' || caster.body === 0x29A || caster.body === 0x29B;
  if (gargoyle) return female ? 0x29B : 0x29A;
  return female ? 0x191 : 0x190;
}

export default {
  name: 'vampiric-embrace', school: 'necromancy', circle: 7, mana: 23,
  cast(api, ctx) {
    const caster = ctx.sender;
    if (caster._origBody != null) {
      ctx.state.sendSystemMessage('You are already transformed.');
      return;
    }
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x3779, hue: 0x44 }));
    broadcastSound(api, api.world, caster, 0x020A);
    // Stash original body/hue so onRemove can restore it. Same guard as
    // Lich Form / Wraith Form prevents two transformations from fighting
    // over the shared `_origBody` rollback slot.
    caster._origBody = caster.body;
    caster._origHue = caster.hue;
    caster.body = vampiricBody(caster);
    caster.hue  = 0x847E;
    try { broadcastBodyChange(api, api.world, caster); } catch { /* test stub */ }
    // Resist overlay merge — fire malus on the shared `_resistOverlay`.
    caster._resistOverlay ??= { physical: 0, fire: 0, cold: 0, poison: 0, energy: 0 };
    caster._resistOverlay.fire = (caster._resistOverlay.fire | 0) - 25;
    caster._vampFireDelta = -25;
    caster._resBagDirty = true;
    // Poison immunity at Necromancy > 99 (ServUO `VampiricEmbrace.OnHit`).
    const necro = skillValue(caster, 50);
    caster._vampImmunePoison = necro > 99;
    api.statusEffects?.apply?.(caster, {
      name: 'vampiric-embrace',
      durationMs: 180_000,
      onRemove(mob) {
        if (mob._origBody != null) { mob.body = mob._origBody; delete mob._origBody; }
        if (mob._origHue  != null) { mob.hue  = mob._origHue;  delete mob._origHue; }
        if (mob._resistOverlay) {
          mob._resistOverlay.fire = (mob._resistOverlay.fire | 0) - (mob._vampFireDelta | 0);
          mob._vampFireDelta = 0;
          const all0 = !mob._resistOverlay.physical && !mob._resistOverlay.fire
                    && !mob._resistOverlay.cold && !mob._resistOverlay.poison
                    && !mob._resistOverlay.energy;
          if (all0) mob._resistOverlay = null;
          else mob._resBagDirty = true;
        }
        mob._vampImmunePoison = false;
        try { broadcastBodyChange(api, api.world, mob); } catch { /* ignore */ }
      },
    });
    ctx.state.sendSystemMessage('You hunger for the blood of others.');
  },
};
