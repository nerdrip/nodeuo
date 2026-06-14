import { summonOne } from '../../_summon-helpers.js';

export default {
  name: 'summon-earth-elemental',
  cast(api, ctx) {
    api.combat.animate(api.world, ctx.sender, 0x10);
    summonOne(api, ctx, {
      kind: 'earth-elemental', soundId: 0x217,
      label: 'You summon an earth elemental.',
    });
  },
};
