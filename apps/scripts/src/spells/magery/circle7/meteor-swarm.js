import { broadcastEffect, broadcastSound, applySpellDamage, mobilesNear } from '../../_helpers.js';

export default {
  name: 'meteor-swarm',
  targetKind: 'location',
  // Audit #40 P2 #12 — ServUO `MeteorSwarm.cs` → 100% fire damage.
  damageType: { fire: 100 },
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, picked, 0x160);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: caster.serial, to: caster.serial,
      itemId: 0x36D4,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: picked.x, toY: picked.y, toZ: picked.z,
      speed: 5, duration: 0,
      fixedDirection: 0, explodes: 1,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    let hit = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, 3, caster)) {
      const dmg = 18 + Math.floor(Math.random() * 11);
      applySpellDamage(api, m, dmg, caster, this);
      hit++;
    }
    ctx.state.sendSystemMessage(`Meteors strike ${hit} being(s).`);
  },
};
