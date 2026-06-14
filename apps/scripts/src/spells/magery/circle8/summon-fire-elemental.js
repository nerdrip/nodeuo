import { summonOne } from '../../_summon-helpers.js';

export default {
  name: 'summon-fire-elemental',
  cast(api, ctx) {
    api.combat.animate(api.world, ctx.sender, 0x10);
    summonOne(api, ctx, {
      kind: 'fire-elemental', soundId: 0x217,
      label: 'You summon a fire elemental.',
    });
  },
};
