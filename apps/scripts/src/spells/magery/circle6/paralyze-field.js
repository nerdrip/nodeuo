import { spawnField } from '../../_field-helpers.js';

// Paralyze Field — 5 glittering tiles. Anyone walking onto one gets
// the `frozen` flag for ~5 s (no movement until the effect timer
// expires server-side). Caster exempt.
export default {
  name: 'paralyze-field',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    spawnField(api, ctx, picked, {
      itemId: 0x3967,                  // ParalyzeField east-west
      length: 5,
      durationMs: 30_000,
      soundId: 0x204,
      name: 'a paralyze field',
      onWalkOn(world, item, mob) {
        if (!mob || (mob.hp ?? 0) <= 0) return;
        // FLAG_FROZEN handled by the movement gate in the server
        // movement handler. Auto-clears 5 s later so the player isn't
        // stuck forever just for crossing the tile once.
        mob.frozen = true;
        if (api.combat?.applyEffect) {
          api.combat.applyEffect(mob, { name: 'paralyze', durationMs: 5_000 });
        } else {
          setTimeout(() => { mob.frozen = false; }, 5_000).unref?.();
        }
        mob.client?.sendSystemMessage?.('You are paralyzed by the field!');
      },
    });
    ctx.state.sendSystemMessage('A glittering wall arcs across the ground.');
  },
};
