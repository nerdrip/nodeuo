// Auto-extracted from spells/schools/bard-mastery.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

import { mobilesNear } from '../_helpers.js';

function radius(api, caster, r, fn) {
  for (const m of mobilesNear(api, caster, r)) fn(m);
}

export default {
  name: 'tribulation',
  cast(api, ctx) {
    const caster = ctx.sender;
    radius(api, caster, 8, (m) => {
          if (m === caster || m.notoriety === 1) return;
          m.tribulationUntil = Date.now() + 20_000;
          m.tribulationPct = 0.20;
        });
  },
};
