// Strangle — Necromancy DoT: target takes ticks of damage every ~2s for
// up to 5 ticks. ServUO scales by SpiritSpeak; we use Necromancy skill
// to size the per-tick damage.

import { aura, broadcastEffect, broadcastSound, echoConduitDamage, SKILL_SPIRIT_SPEAK, skillValue } from '../_helpers.js';

export default {
  name: 'strangle',
  school: 'necromancy',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Strangle needs a target.');
      return;
    }
    const fx = aura(api, target, { itemId: 0x375A, hue: 0x015 });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x0204);

    // Audit #32 P2 #5 — ServUO `Strangle.cs:71-249` formula. Was: flat
    // 5 ticks at 2 s using Necromancy (wrong skill, no stamina scaling).
    // Now: Spirit Speak (skill 33) drives ticks count + damage range,
    // tick interval decays from 5 s → 1 s as ticks count down, damage
    // scales inversely with stamina, and non-players take ×1.75. The
    // status-effect framework only honours a single `tickIntervalMs`,
    // so we drive cadence manually via setTimeout chain instead of
    // letting `tickAll` schedule.
    // Audit #41 P1 #3 — Spirit Speak is skill 33 (skill 32 = Archery).
    const ss = skillValue(caster, SKILL_SPIRIT_SPEAK);
    const baseTicks = Math.max(4, Math.floor(ss / 10));
    let ticksLeft = baseTicks;
    const nonPlayerMul = target.client ? 1 : 1.75;
    function fireTick() {
      if (ticksLeft <= 0) return;
      if (!target || (target.hp ?? 0) <= 0) return;
      // Audit #36 P2 #8 — Stone Form immunity. ServUO
      // `StoneFormSpell.CheckImmunity` short-circuits Strangle ticks.
      if (target._stoneForm) {
        if (caster.client) caster.client.sendSystemMessage('Your spell has no effect.');
        return;
      }
      const stamFrac = (target.stam ?? 0) / Math.max(1, target.stamMax ?? 50);
      const lo = Math.max(1, Math.floor(ss / 10 - 2));
      const hi = Math.max(lo, Math.floor(ss / 10 + 1));
      const roll = lo + Math.floor(Math.random() * (hi - lo + 1));
      const dmg = Math.max(1, Math.round(roll * (3 - 2 * stamFrac) * nonPlayerMul));
      // Audit #36 P2 #8 — ServUO `Strangle.cs:101` damages cold-typed
      // (`AOS.Damage(m,from,dmg,0,0,0,100,0)`). Was untyped, ignored
      // cold resists.
      api.combat.damage(api.world, target, dmg, caster, { cold: 100 });
      echoConduitDamage(api, caster, target, dmg, { cold: 100 });
      // ServUO `Strangle.cs:108-110`: calls `m.Spell.OnCasterHurt()` on
      // each tick (disturbs target's cast) + 60% reveal-from-hide.
      try { api.spells?.disturbCast?.(target); } catch { /* no-op */ }
      if (target.hidden && Math.random() < 0.6) target.hidden = false;
      api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
      ticksLeft -= 1;
      // ServUO interval: starts at 5s, drops linearly to 1s by the
      // last tick. Cheap approximation: 1000 + ticksLeft * 800.
      const nextMs = Math.max(1000, 1000 + ticksLeft * 800);
      setTimeout(fireTick, nextMs).unref?.();
    }
    api.statusEffects?.apply?.(target, {
      name: 'strangle',
      durationMs: baseTicks * 5000,
    });
    setTimeout(fireTick, 5000).unref?.();
    if (target.client) target.client.sendSystemMessage('You feel ghostly hands tighten around your throat.');
  },
};
