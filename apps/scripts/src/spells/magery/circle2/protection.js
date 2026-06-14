import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';

const SKILL_INSCRIBE = 24;

export default {
  name: 'protection',
  cast(api, ctx) {
    const caster = ctx.sender;
    // Audit #40 P2 #11 — ServUO `Protection.cs:36-101`. Real mechanic:
    //   - indefinite duration; re-cast TOGGLES OFF
    //   - no flat damage reduction (the 0.25 was invented)
    //   - main effect: suppresses cast-disrupt on incoming damage
    //   - resist mod: −15 physical + min(15, inscribe/20), and
    //                 −35 magic-resist while active
    // Cast.js gates the disrupt path on `_protectionUntil`.
    if ((caster._protectionUntil ?? 0) > Date.now()) {
      // Toggle off.
      caster._protectionUntil = 0;
      const overlay = caster._resistOverlay;
      if (overlay) {
        const phys = caster._protectionPhysDelta | 0;
        overlay.physical = (overlay.physical | 0) - phys;
        const isAllZero = !overlay.physical && !overlay.fire && !overlay.cold
                       && !overlay.poison && !overlay.energy;
        if (isAllZero) caster._resistOverlay = null;
        else caster._resBagDirty = true;
      }
      caster._protectionPhysDelta = 0;
      ctx.state.sendSystemMessage('You feel less protected.');
      return;
    }
    api.combat.animate(api.world, caster, 0x11);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: caster.serial, to: caster.serial,
      itemId: 0x376A,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: caster.x, toY: caster.y, toZ: caster.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x1ED);
    caster._protectionUntil = Number.MAX_SAFE_INTEGER;
    caster._protectionInscribe = skillValue(caster, SKILL_INSCRIBE);
    // Physical resist delta = -15 + min(15, inscribe/20). Net malus
    // softens with Inscription skill but never becomes a bonus.
    const physDelta = -15 + Math.min(15, Math.floor(caster._protectionInscribe / 20));
    caster._resistOverlay ??= { physical: 0, fire: 0, cold: 0, poison: 0, energy: 0 };
    caster._resistOverlay.physical = (caster._resistOverlay.physical | 0) + physDelta;
    caster._protectionPhysDelta = physDelta;
    caster._resBagDirty = true;
    ctx.state.sendSystemMessage('You feel protected.');
  },
};
