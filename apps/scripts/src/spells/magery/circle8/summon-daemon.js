import { summonOne } from '../../_summon-helpers.js';

export default {
  name: 'summon-daemon',
  cast(api, ctx) {
    api.combat.animate(api.world, ctx.sender, 0x10);
    summonOne(api, ctx, {
      kind: 'daemon', soundId: 0x216, followerCost: 4,
      label: 'You summon a daemon.',
    });
  },
};
