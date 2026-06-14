import { spawnField } from '../../_field-helpers.js';

// Fire Field — 5 burning tiles. Anyone walking onto one takes 4..8
// fire damage. Persists 30 s. Caster is exempt (UO convention).
export default {
  name: 'fire-field',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    spawnField(api, ctx, picked, {
      itemId: 0x398C,                  // FireField east-west ribbon
      length: 5,
      durationMs: 30_000,
      soundId: 0x20C,
      name: 'a wall of fire',
      onWalkOn(world, item, mob) {
        if (!mob || (mob.hp ?? 0) <= 0) return;
        const dmg = 4 + Math.floor(Math.random() * 5);
        const newHp = Math.max(0, (mob.hp ?? 0) - dmg);
        mob.hp = newHp;
        if (mob.client && api.protocol?.healthUpdate) {
          mob.client.send(api.protocol.healthUpdate({
            serial: mob.serial, current: newHp, max: mob.hpMax ?? newHp,
          }));
        }
        mob.client?.sendSystemMessage?.('You are scorched by flame!');
      },
    });
    ctx.state.sendSystemMessage('Wisps of flame curl across the ground.');
  },
};
