import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';

export default {
  name: 'reactive-armor',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x11);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: caster.serial, to: caster.serial,
      itemId: 0x376A,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: caster.x, toY: caster.y, toZ: caster.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0x01F, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x1F2);
    // Audit #36 P1 #1 — ServUO `ReactiveArmor.cs:75-104` AOS path
    // installs resist mods: +(15 + Inscribe/20) physical, -5 each
    // elemental, indefinite (toggle off by re-cast). Was: 20% damage
    // reflect for 60 s. Re-cast toggles off.
    if (caster._reactiveArmor) {
      // Audit #41 P1 #9 — subtract OUR delta, not clobber the overlay.
      // Stone Form / Reaper Form / Lich Form / Corpse Skin / Magic
      // Reflection all share `_resistOverlay`.
      caster._reactiveArmor = false;
      const overlay = caster._resistOverlay;
      if (overlay) {
        const physDelta = caster._raPhysDelta | 0;
        overlay.physical = (overlay.physical | 0) - physDelta;
        overlay.fire     = (overlay.fire     | 0) + 5;
        overlay.cold     = (overlay.cold     | 0) + 5;
        overlay.poison   = (overlay.poison   | 0) + 5;
        overlay.energy   = (overlay.energy   | 0) + 5;
        const all0 = !overlay.physical && !overlay.fire && !overlay.cold
                  && !overlay.poison && !overlay.energy;
        if (all0) caster._resistOverlay = null;
        else caster._resBagDirty = true;
      }
      caster._raPhysDelta = 0;
      ctx.state.sendSystemMessage('The protective aura fades.');
      try { api.statusEffects?.remove?.(caster, 'reactive-armor', api.world); } catch { /* ignore */ }
      return;
    }
    const inscribe = skillValue(caster, 24);
    const physBonus = 15 + Math.floor(inscribe / 20);
    caster._raPhysDelta = physBonus;
    // Merge with any existing overlay (e.g. Magic Reflection) instead
    // of clobbering — both spells live on `_resistOverlay`.
    const prior = caster._resistOverlay ?? {};
    caster._resistOverlay = {
      physical: (prior.physical | 0) + physBonus,
      fire:     (prior.fire     | 0) - 5,
      cold:     (prior.cold     | 0) - 5,
      poison:   (prior.poison   | 0) - 5,
      energy:   (prior.energy   | 0) - 5,
    };
    caster._resBagDirty = true;
    caster._reactiveArmor = true;
    if (api.statusEffects) {
      api.statusEffects.apply(caster, {
        name: 'reactive-armor',
        // No durationMs — indefinite, cleared by re-cast.
      });
    }
    ctx.state.sendSystemMessage('You are surrounded by a protective aura.');
  },
};
