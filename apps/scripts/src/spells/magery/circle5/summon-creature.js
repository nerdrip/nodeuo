import { summonOne } from '../../_summon-helpers.js';
import { broadcastSound } from '../../_helpers.js';

// Summon Creature — picks a random low-tier critter and spawns it as
// a temporary pet at the caster's side. Despawns after 2 minutes
// (UO retail summon timer baseline). Mirrors the spellweaving
// summon-fey path which already works against `api.ctx.spawnFactory`.
const SUMMON_CHOICES = ['horse', 'cow', 'bull', 'rat', 'cat', 'dog', 'sheep', 'pig'];

export default {
  name: 'summon-creature',
  cast(api, ctx) {
    const kind = SUMMON_CHOICES[Math.floor(Math.random() * SUMMON_CHOICES.length)];
    api.combat.animate(api.world, ctx.sender, 0x10);
    broadcastSound(api, api.world, ctx.sender, 0x215);
    summonOne(api, ctx, {
      kind,
      soundId: 0,
      followerCost: 1,
      label: `You summon ${kind === 'cat' ? 'a cat' : `a ${kind}`}.`,
    });
  },
};
