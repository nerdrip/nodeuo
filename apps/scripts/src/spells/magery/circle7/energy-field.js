import { spawnField } from '../../_field-helpers.js';

// Energy Field — 5 crackling tiles. Mostly a wall (heavy step damage).
// Caster exempt.
export default {
  name: 'energy-field',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    spawnField(api, ctx, picked, {
      itemId: 0x3946,                  // EnergyField east-west
      length: 5,
      durationMs: 30_000,
      soundId: 0x20A,
      name: 'an energy field',
      onWalkOn(world, item, mob) {
        if (!mob || (mob.hp ?? 0) <= 0) return;
        const dmg = 6 + Math.floor(Math.random() * 7);
        const newHp = Math.max(0, (mob.hp ?? 0) - dmg);
        mob.hp = newHp;
        if (mob.client && api.protocol?.healthUpdate) {
          mob.client.send(api.protocol.healthUpdate({
            serial: mob.serial, current: newHp, max: mob.hpMax ?? newHp,
          }));
        }
        mob.client?.sendSystemMessage?.('Crackling energy lashes you!');
      },
    });
    ctx.state.sendSystemMessage('Crackling energy stretches across the ground.');
  },
};
