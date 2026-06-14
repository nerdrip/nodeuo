import { mobileBySerial } from '../../_entities.js';
// Auto-extracted from spells/schools/masteries.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

export default {
  name: 'body-guard',
  cast(api, ctx) {
    const caster = ctx.sender;
    caster.bodyGuardUntil = Date.now() + 30_000;
        const world = api.world;
        if (!world || !caster._partyMembers) return;
        for (const serial of caster._partyMembers) {
          const m = mobileBySerial({ world }, serial);
          if (!m) continue;
          const dx = Math.abs(m.x - caster.x), dy = Math.abs(m.y - caster.y);
          if (dx > 8 || dy > 8) continue;
          m.bodyGuardUntil = Date.now() + 30_000;
        }
  },
};
