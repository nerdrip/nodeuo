import { broadcastEffect, broadcastSound, applySpellDamage } from '../../_helpers.js';

export default {
  name: 'magic-arrow',
  // Audit #40 P2 #12 — ServUO `MagicArrow.cs:71` → 100% fire damage.
  damageType: { fire: 100 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) {
      ctx.state.sendSystemMessage('Magic arrow needs a target.');
      return;
    }
    const dmg = 6 + Math.floor(Math.random() * 7); // 6..12
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: caster.serial, to: target.serial,
      itemId: 0x36E4,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 7, duration: 0,
      fixedDirection: 1, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, target, 0x01E5);
    applySpellDamage(api, target, dmg, caster, this);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
