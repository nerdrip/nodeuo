import { spawnField } from '../../_field-helpers.js';

// Poison Field — 5 venomous tiles. Anyone walking onto one gets the
// `poisoned` flag set + a small DOT tick. Caster exempt.
export default {
  name: 'poison-field',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    spawnField(api, ctx, picked, {
      itemId: 0x3915,                  // PoisonField east-west
      length: 5,
      durationMs: 45_000,
      soundId: 0x205,
      name: 'a poison field',
      hue: 0x40,
      onWalkOn(world, item, mob) {
        if (!mob || (mob.hp ?? 0) <= 0) return;
        // Mark as poisoned (FLAG_POISONED = 0x04). Real shards run a
        // proper status-effect ticker; we set the flag + a single DoT
        // chip so the visual + sysmsg fire even before the full
        // poison module is wired.
        mob.flags = (mob.flags | 0) | 0x04;
        const dmg = 2 + Math.floor(Math.random() * 3);
        const newHp = Math.max(0, (mob.hp ?? 0) - dmg);
        mob.hp = newHp;
        if (mob.client && api.protocol?.healthUpdate) {
          mob.client.send(api.protocol.healthUpdate({
            serial: mob.serial, current: newHp, max: mob.hpMax ?? newHp,
          }));
        }
        mob.client?.sendSystemMessage?.('You are poisoned by the field!');
      },
    });
    ctx.state.sendSystemMessage('Poisonous vapors curl across the ground.');
  },
};
