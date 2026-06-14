import { broadcastEffect, broadcastSound } from '../../_helpers.js';

// Like mana-drain but the stolen mana is transferred to the caster (capped
// by their manaMax). Functional — no infrastructure gap.
export default {
  name: 'mana-vampire',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) { ctx.state.sendSystemMessage('Mana Vampire needs a target.'); return; }
    const stolen = Math.min(target.mana ?? 0, 20 + Math.floor(Math.random() * 15));
    target.mana = Math.max(0, (target.mana ?? 0) - stolen);
    const cap = caster.manaMax ?? 50;
    caster.mana = Math.min(cap, (caster.mana ?? 0) + stolen);

    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: target.serial, to: caster.serial,
      itemId: 0x374A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: caster.x, toY: caster.y, toZ: caster.z,
      speed: 7, duration: 0,
      fixedDirection: 1, explodes: 0,
      hue: 0x1C2, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x1F8);

    if (target.client && api.protocol.manaUpdate) {
      target.client.send(api.protocol.manaUpdate({
        serial: target.serial, current: target.mana, max: target.manaMax ?? 50,
      }));
    }
    if (caster.client && api.protocol.manaUpdate) {
      caster.client.send(api.protocol.manaUpdate({
        serial: caster.serial, current: caster.mana, max: cap,
      }));
    }
    ctx.state.sendSystemMessage(`You drain ${stolen} mana.`);
  },
};
