import { broadcastEffect, broadcastSound, applySpellDamage } from '../../_helpers.js';

export default {
  name: 'harm',
  // Audit #40 P2 #12 — ServUO `Harm.cs:88` → 100% cold damage.
  damageType: { cold: 100 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Harm needs a target.'); return; }
    const dmg = 5 + Math.floor(Math.random() * 6); // 5..10
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x374A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x01F1);
    applySpellDamage(api, target, dmg, caster, this);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
