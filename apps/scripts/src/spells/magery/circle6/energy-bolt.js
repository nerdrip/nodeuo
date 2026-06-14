import { broadcastEffect, broadcastSound, applySpellDamage } from '../../_helpers.js';

export default {
  name: 'energy-bolt',
  // Audit #40 P2 #12 — ServUO `EnergyBolt.cs` → 50% physical + 50% energy.
  damageType: { physical: 50, energy: 50 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Energy bolt needs a target.'); return; }
    const dmg = 18 + Math.floor(Math.random() * 11); // 18..28
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: caster.serial, to: target.serial,
      itemId: 0x379F,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 7, duration: 0,
      fixedDirection: 1, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, target, 0x20A);
    applySpellDamage(api, target, dmg, caster, this);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
