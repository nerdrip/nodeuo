import { summonOne } from '../../_summon-helpers.js';

// Blade Spirits — autonomous spinning blades. Friendly to caster,
// hostile to everything else. Despawn after 90 s.
export default {
  name: 'blade-spirits',
  cast(api, ctx) {
    api.combat.animate(api.world, ctx.sender, 0x10);
    summonOne(api, ctx, {
      kind: 'blade-spirits', soundId: 0x212,
      durationMs: 90_000,
      aggressive: true,
      label: 'You summon blade spirits.',
    });
  },
};
