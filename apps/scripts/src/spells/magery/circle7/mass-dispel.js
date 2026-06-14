import { broadcastSound, mobilesNear } from '../../_helpers.js';

export default {
  name: 'mass-dispel',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x201);
    if (!api.statusEffects) return;
    let stripped = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, 3)) {
      for (const eff of (m.effects ?? []).slice()) {
        if (!eff.name || eff.name === 'poison') continue;
        api.statusEffects.remove(m, eff.name, api.world);
        stripped++;
      }
    }
    ctx.state.sendSystemMessage(`Dispelled ${stripped} effect(s).`);
  },
};
