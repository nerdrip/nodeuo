import { applySingleStatBuff, broadcastEffect, broadcastSound } from '../../_helpers.js';

export default {
  name: 'clumsy',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Clumsy needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x374A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0x3B, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x1DF);
    if (api.statusEffects) applySingleStatBuff(api, target, 'clumsy', 'dex', -10, 60_000);
  },
};
