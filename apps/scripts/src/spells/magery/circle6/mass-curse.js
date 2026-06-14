import { applyStatBuff, broadcastSound, mobilesNear } from '../../_helpers.js';
import { NOTO, viewerNotoriety } from '../../../_notoriety.js';

export default {
  name: 'mass-curse',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1EA);
    if (!api.statusEffects) return;
    // Audit #40 P3 #19 — symmetric to Arch Cure: only valid targets
    // for an offensive AoE are non-innocent / non-ally mobs. Was:
    // cursed every mob in range including blue players (the caster
    // got the criminal flag from flagBeneficialOnCriminal in #28, but
    // the curse landed before the flag, and the blue victim couldn't
    // even resist via flagging because the spell was already done).
    let count = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, 2, caster)) {
      const noto = viewerNotoriety(api, m, caster, api.world);
      if (noto === NOTO.Innocent || noto === NOTO.Ally) continue;
      applyStatBuff(api, m, 'curse', -10, 60_000);
      count++;
    }
    ctx.state.sendSystemMessage(`You curse ${count} being(s).`);
  },
};
