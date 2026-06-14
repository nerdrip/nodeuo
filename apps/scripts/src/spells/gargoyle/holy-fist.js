// Auto-extracted from spells/schools/gargoyle.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

import { skillValue } from '../_helpers.js';

const SKILL_INSCRIPTION = 24;

export default {
  name: 'holy-fist',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) { ctx.state.sendSystemMessage('Holy Fist needs a target.'); return; }
        if (caster.race !== 'gargoyle'
            && caster.body !== 0x029A && caster.body !== 0x029B
            && (caster.accessLevel ?? '') === '') {
          ctx.state.sendSystemMessage('Only gargoyles may invoke Holy Fist.');
          return;
        }
        const skill = skillValue(caster, SKILL_INSCRIPTION);
        const dmg = Math.floor(30 + skill / 3);
        // 100 % energy-typed damage. Bypasses physical resist.
        api.combat?.damage?.(api.world, target, dmg, caster, { damageType: { energy: 100 } });
  },
};
