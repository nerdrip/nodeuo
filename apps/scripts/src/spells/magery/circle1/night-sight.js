import { broadcastEffect, broadcastSound } from '../../_helpers.js';

export default {
  name: 'night-sight',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x11);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: caster.serial, to: caster.serial,
      itemId: 0x376A,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: caster.x, toY: caster.y, toZ: caster.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x1E3);
    // ServUO `NightSightSpell.OnCast` sets `Mobile.LightLevel = 25` and
    // pushes 0x4E PersonalLight. The CLIENT clamps to 0..30 and
    // SUBTRACTS the personal level from the overall darkness — so
    // HIGHER personal light = BRIGHTER near the player. Was: sent
    // level=0 → zero brightness boost → screen stayed dark.
    if (api.protocol?.personalLightLevel && ctx.state?.send) {
      try { ctx.state.send(api.protocol.personalLightLevel(caster.serial, 25)); }
      catch { /* protocol shape mismatch tolerated */ }
    }
    if (api.statusEffects) {
      api.statusEffects.apply(caster, {
        name: 'night-sight',
        durationMs: 600_000,
        onRemove(_mob, _world) {
          // On expiry, push level=0 so the player's personal light goes
          // back to "no boost" and they see ambient darkness again.
          try {
            if (api.protocol?.personalLightLevel && caster.client) {
              caster.client.send(api.protocol.personalLightLevel(caster.serial, 0));
            }
            caster.client?.sendSystemMessage?.('Your night sight fades.');
          } catch { /* advisory */ }
        },
      });
    }
    ctx.state.sendSystemMessage('Your eyes adjust to the darkness.');
  },
};
