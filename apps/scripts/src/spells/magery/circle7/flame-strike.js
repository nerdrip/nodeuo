import { broadcastEffect, broadcastSound, applySpellDamage } from '../../_helpers.js';

export default {
  name: 'flame-strike',
  // Audit #40 P2 #12 — ServUO `FlameStrike.cs` → 100% fire damage.
  damageType: { fire: 100 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Flame strike needs a target.'); return; }
    const dmg = 25 + Math.floor(Math.random() * 16); // 25..40
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Stationary,
      from: target.serial, to: target.serial,
      itemId: 0x3709,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 9, duration: 30,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x208);
    applySpellDamage(api, target, dmg, caster, this);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
