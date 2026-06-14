import { applySingleStatBuff, broadcastEffect, broadcastSound } from '../../_helpers.js';

export default {
  name: 'agility',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Agility needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x11);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x373A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x1E7);
    if (api.statusEffects) applySingleStatBuff(api, target, 'agility', 'dex', +10, 60_000);
  },
};
