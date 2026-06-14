import { broadcastSound, mobilesNear } from '../../_helpers.js';
import { NOTO, viewerNotoriety } from '../../../_notoriety.js';

export default {
  name: 'arch-cure',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x11);
    broadcastSound(api, api.world, caster, 0x1E0);
    if (!api.statusEffects) return;
    // Audit #40 P3 #19 — ServUO `ArchCure.cs:117-149 AreaCanTarget`
    // refuses anyone who isn't innocent/ally: aggressors, aggressed,
    // and Felucca non-players. Was: cured every target in the AoE,
    // letting a red player mass-cure their guildmate-grief target
    // group regardless of standing.
    let cured = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, 2)) {
      if (m !== caster) {
        const noto = viewerNotoriety(api, m, caster, api.world);
        if (noto !== NOTO.Innocent && noto !== NOTO.Ally) continue;
      }
      // Audit #41 P1 #8 — clear canonical poison fields too (status-
      // effects.remove returns false when poison lives outside that
      // framework, post-#40-P1-#3). Match cure.js behaviour.
      const wasPoisoned = !!m.poisoned || api.statusEffects.has?.(m, 'poison');
      m.poisoned = false;
      m.poisonLevel = 0;
      m._poisonExpiresAt = 0;
      if (api.statusEffects.remove(m, 'poison', api.world) || wasPoisoned) cured++;
    }
    ctx.state.sendSystemMessage(`Arch cure lifts poison from ${cured} being(s).`);
  },
};
