// Auto-extracted from spells/schools/masteries.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

import { mobilesNear } from '../_helpers.js';

export default {
  name: 'heighten-senses',
  cast(api, ctx) {
    const caster = ctx.sender;
    caster.heightenSensesUntil = Date.now() + 30_000;
        for (const m of mobilesNear(api, caster, 12, caster)) {
          if (m === caster || !m.hidden) continue;
          m.hidden = false;
        }
  },
};
