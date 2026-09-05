// Death Strike — Ninjitsu delayed-damage ability. The struck target
// takes a chunk of damage 5 seconds later, doubled when they move during
// the countdown (ServUO `DeathStrike.cs`). The central status scheduler owns
// the delay so script reload/shutdown does not leave an orphaned raw timer.

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';

export default {
  name: 'death-strike',
  school: 'ninjitsu',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Death Strike needs a target.');
      return;
    }
    const fx = aura(api, target, { itemId: 0x37CC, hue: 0x49, duration: 30 });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x21F);

    const ninjitsu = skillValue(caster, 54);
    const baseDamage = 12 + Math.floor(ninjitsu / 8); // 12..27
    const appliedAt = Date.now();
    let resolved = false;
    api.statusEffects?.apply?.(target, {
      name: 'death-strike', durationMs: 30_000, tickIntervalMs: 5_000,
      data: { casterSerial: caster.serial >>> 0, baseDamage, appliedAt },
      onTick(mob, world) {
        if (resolved) return;
        resolved = true;
        const activeWorld = world ?? api.world;
        if ((mob.hp ?? 0) > 0 && activeWorld?.mobiles?.has?.(mob.serial)) {
          const moved = (mob._lastMoveAt ?? 0) > appliedAt;
          const damage = moved ? baseDamage * 2 : baseDamage;
          api.combat.damage(activeWorld, mob, damage, caster);
          api.combat.animate(activeWorld, mob, 0x14, { frameCount: 3 });
          mob.client?.sendSystemMessage?.(
            moved ? 'Your movement unleashes a devastating Death Strike.'
              : 'A killing blow lands on your back.',
          );
        }
        api.statusEffects?.remove?.(mob, 'death-strike', activeWorld);
      },
    });
    ctx.state.sendSystemMessage('Your Death Strike is set.');
  },
};
