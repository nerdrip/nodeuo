// Auto-extracted from spells/schools/bard-mastery.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

import { mobilesNear } from '../_helpers.js';

function radius(api, caster, r, fn) {
  for (const m of mobilesNear(api, caster, r)) fn(m);
}

export default {
  name: 'despair',
  cast(api, ctx) {
    const caster = ctx.sender;
    radius(api, caster, 8, (m) => {
          if (m === caster || m.notoriety === 1) return;
          m.statDebuffUntil = Date.now() + 20_000;
          m.statDebuffPct = 0.10;
          m._despairUntil = Date.now() + 20_000;
          m._despairDmg = 10;
          m._despairNextTickAt = Date.now() + 2_000;
        });
  },
};
