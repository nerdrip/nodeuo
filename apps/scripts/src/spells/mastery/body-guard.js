import { mobileBySerial } from '../../_entities.js';
// Auto-extracted from spells/schools/masteries.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

export default {
  name: 'body-guard',
  cast(api, ctx) {
    const caster = ctx.sender;
    caster._bodyGuardUntil = Date.now() + 30_000;
        const world = api.world;
        const party = api.party?.partyOf?.(caster.serial);
        if (!world || !party) return;
        for (const serial of party.members ?? []) {
          const m = mobileBySerial({ world }, serial);
          if (!m) continue;
          const dx = Math.abs(m.x - caster.x), dy = Math.abs(m.y - caster.y);
          if (dx > 8 || dy > 8) continue;
          m._bodyGuardUntil = Date.now() + 30_000;
        }
  },
};
