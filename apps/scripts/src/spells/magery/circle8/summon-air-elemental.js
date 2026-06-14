import { summonOne } from '../../_summon-helpers.js';

export default {
  name: 'summon-air-elemental',
  cast(api, ctx) {
    api.combat.animate(api.world, ctx.sender, 0x10);
    summonOne(api, ctx, {
      kind: 'air-elemental', soundId: 0x217,
      label: 'You summon an air elemental.',
    });
  },
};
