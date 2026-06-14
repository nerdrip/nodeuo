// Auto-extracted from spells/schools/masteries.js by tools/extract-mastery-spells.mjs.
// Metadata lives in data/config/spells.json; this file only carries
// the cast() implementation.

export default {
  name: 'pierce',
  cast(api, ctx) {
    const caster = ctx.sender;
    caster.pierceCharge = 1;
  },
};
