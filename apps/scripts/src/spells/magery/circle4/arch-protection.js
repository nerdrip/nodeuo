import { broadcastSound, mobilesNear } from '../../_helpers.js';

export default {
  name: 'arch-protection',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x11);
    broadcastSound(api, api.world, caster, 0x1ED);
    if (!api.statusEffects) return;
    let covered = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, 2)) {
      api.statusEffects.apply(m, {
        name: 'protection', durationMs: 60_000, data: { reduce: 0.25 },
      });
      covered++;
    }
    ctx.state.sendSystemMessage(`${covered} being(s) are protected.`);
  },
};
