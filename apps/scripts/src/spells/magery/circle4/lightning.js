import { broadcastEffect, broadcastSound, applySpellDamage } from '../../_helpers.js';

export default {
  name: 'lightning',
  // Audit #40 P2 #12 — ServUO `Lightning.cs` → 100% energy damage.
  damageType: { energy: 100 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Lightning needs a target.'); return; }
    const dmg = 12 + Math.floor(Math.random() * 11); // 12..22
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.graphicalEffect({
      kind: api.protocol.EffectKind.Lightning,
      from: target.serial, to: target.serial,
      itemId: 0,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 0, duration: 0,
      fixedDirection: 0, explodes: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x029);
    applySpellDamage(api, target, dmg, caster, this);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
