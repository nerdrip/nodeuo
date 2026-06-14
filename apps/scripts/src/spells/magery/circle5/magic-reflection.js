import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';

// Sets a `magicReflection` flag the spell-resolution pipeline can check (when
// the combat side learns to read it). Status-effect cleanly clears on expiry.
export default {
  name: 'magic-reflection',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: caster.serial, to: caster.serial,
      itemId: 0x376A,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: caster.x, toY: caster.y, toZ: caster.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0x47E, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x1E9);
    // Audit #36 P3 #16 — ServUO `MagicReflect.cs:67-117`: indefinite
    // duration, re-cast toggles OFF. Was: fixed 60-s timer. Re-casting
    // mid-window now correctly drops the buff so duelists can clear
    // the shimmer before re-engaging.
    if (caster.magicReflection) {
      // Audit #41 P1 #9 — must subtract OUR delta, not clobber the whole
      // overlay. Stone Form / Reaper Form / Lich Form / Corpse Skin
      // share `_resistOverlay` and their contributions stay live even
      // when Magic Reflection toggles off.
      caster.magicReflection = false;
      const overlay = caster._resistOverlay;
      if (overlay) {
        const physDelta = caster._mrPhysDelta | 0;
        overlay.physical = (overlay.physical | 0) - physDelta;
        overlay.fire     = (overlay.fire     | 0) - 10;
        overlay.cold     = (overlay.cold     | 0) - 10;
        overlay.poison   = (overlay.poison   | 0) - 10;
        overlay.energy   = (overlay.energy   | 0) - 10;
        const all0 = !overlay.physical && !overlay.fire && !overlay.cold
                  && !overlay.poison && !overlay.energy;
        if (all0) caster._resistOverlay = null;
        else caster._resBagDirty = true;
      }
      caster._mrPhysDelta = 0;
      try { api.statusEffects?.remove?.(caster, 'magic-reflection', api.world); } catch { /* ignore */ }
      ctx.state.sendSystemMessage('The shimmer fades.');
      return;
    }
    const inscribe = skillValue(caster, 24);
    const physMod = -25 + Math.floor(inscribe / 20);
    caster._mrPhysDelta = physMod;
    // Merge with any existing overlay (e.g. Reactive Armor) instead of
    // clobbering — both spells share `_resistOverlay`.
    const prior = caster._resistOverlay ?? {};
    caster._resistOverlay = {
      physical: (prior.physical | 0) + physMod,
      fire:     (prior.fire     | 0) + 10,
      cold:     (prior.cold     | 0) + 10,
      poison:   (prior.poison   | 0) + 10,
      energy:   (prior.energy   | 0) + 10,
    };
    caster._resBagDirty = true;
    caster.magicReflection = true;
    if (api.statusEffects) {
      // No durationMs — indefinite. Re-cast drops it (above).
      api.statusEffects.apply(caster, { name: 'magic-reflection' });
    }
    ctx.state.sendSystemMessage('A faint shimmer wraps around you.');
  },
};
