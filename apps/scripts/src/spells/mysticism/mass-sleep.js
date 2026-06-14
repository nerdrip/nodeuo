import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
// Audit #37 P2 #4 — ServUO `MassSleepSpell.cs:54-82`:
//   radius 3 (was 4); per-target duration
//   `dur = (Mys + max(Focus, Imbuing))/20 + 3 - resist/10` seconds;
//   skip when dur ≤ 0 (high-MR target resists outright).
// Was: flat 6 s with no resist check — 120-MR targets slept on
// command. Skill IDs: 56 Mys, 51 Focus, 57 Imbuing, 27 Resist.
const RADIUS = 3;
export default {
  name: 'mass-sleep', school: 'mysticism', circle: 5, mana: 14,
  cast(api, ctx, picked) {
    if (!picked) return ctx.state.sendSystemMessage('Mass Sleep cancelled.');
    const caster = ctx.sender;
    const mys = skillValue(caster, 56);
    const sec = Math.max(skillValue(caster, 51), skillValue(caster, 57));
    let lulled = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1; if (noto === 1 || noto === 2) continue;
      const mr = skillValue(m, 27);
      const dur = Math.floor((mys + sec) / 20) + 3 - Math.floor(mr / 10);
      if (dur <= 0) continue;
      api.statusEffects?.apply?.(m, { name: 'sleep', durationMs: dur * 1000 });
      lulled++;
    }
    broadcastEffect(api, api.world, picked, aura(api, picked, { itemId: 0x376A, hue: 0x47 }));
    broadcastSound(api, api.world, picked, 0x653);
    ctx.state.sendSystemMessage(`${lulled} fall asleep.`);
  },
};
