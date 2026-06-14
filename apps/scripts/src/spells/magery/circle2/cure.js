import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';
import { flagBeneficialOnCriminal } from '../../../_notoriety.js';

export default {
  name: 'cure',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Cure needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x11);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x373A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x1E0);
    // Detect active poison via the status-effects framework (the
    // `target.poisoned` flag is only stamped by `applyPoison()` —
    // tests apply the raw effect without the flag).
    const hasPoison = target.poisoned || api.statusEffects?.has?.(target, 'poison');
    if (!hasPoison) {
      ctx.state.sendSystemMessage('No poison to cure.');
      return;
    }
    // Audit #36 P2 #11 — ServUO `Cure.cs:38-62` rolls
    //   chance = (10000 + magery*75 - (lvl+1)*(lvl<4?3300:3100)) / 100
    // vs `Random(100)`. Was unconditional remove — low-magery players
    // cured Deadly poison with 100% success. Default lvl=0 (lesser)
    // when target lacks `poisonLevel` (test fixture style).
    const magery = skillValue(caster, 26);
    const lvl = Math.max(0, Math.min(4, (target.poisonLevel | 0)));
    const stepDiv = lvl < 4 ? 3300 : 3100;
    const chance = Math.max(0, (10000 + magery * 75 - (lvl + 1) * stepDiv) / 100);
    if (Math.random() * 100 < chance) {
      // Audit #41 P1 #8 — canonical poison fields are `poisoned` /
      // `poisonLevel` / `_poisonExpiresAt` (since #40 P1 #3 the spell
      // routes through `applyPoison()`, which lives outside the
      // status-effects framework). Was: only removed the status-
      // effect → target stayed poisoned forever.
      target.poisoned = false;
      target.poisonLevel = 0;
      target._poisonExpiresAt = 0;
      api.statusEffects?.remove(target, 'poison', api.world);
      ctx.state.sendSystemMessage('Poison cured.');
    } else {
      ctx.state.sendSystemMessage('You have failed to cure your target!');
    }
    // Audit #35 P2 #9 — beneficial-on-criminal flag.
    try { flagBeneficialOnCriminal(api, caster, target); }
    catch { /* helper not bundled in test harness */ }
  },
};
