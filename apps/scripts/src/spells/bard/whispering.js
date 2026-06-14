// Auto-extracted from spells/schools/bard-mastery.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

import { mobilesNear } from '../_helpers.js';

function radius(api, caster, r, fn) {
  for (const m of mobilesNear(api, caster, r)) fn(m);
}

export default {
  name: 'whispering',
  cast(api, ctx) {
    const caster = ctx.sender;
    radius(api, caster, 12, (m) => {
          if (!m.hidden) return;
          m.hidden = false;
          m.slowedUntil = Date.now() + 8_000;
        });
  },
};
