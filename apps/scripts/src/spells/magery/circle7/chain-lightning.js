import { broadcastEffect, broadcastSound, applySpellDamage, mobilesNear } from '../../_helpers.js';

export default {
  name: 'chain-lightning',
  targetKind: 'location',
  // Audit #40 P2 #12 — ServUO `ChainLightning.cs` → 100% energy.
  damageType: { energy: 100 },
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, picked, 0x29);
    const victims = [];
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, 3, caster)) {
      if (m === caster) continue;
      victims.push(m);
      if (victims.length >= 4) break;
    }
    for (const v of victims) {
      const fx = api.protocol.graphicalEffect({
        kind: api.protocol.EffectKind.Lightning,
        from: v.serial, to: v.serial,
        itemId: 0,
        fromX: v.x, fromY: v.y, fromZ: v.z,
        toX: v.x, toY: v.y, toZ: v.z,
        speed: 0, duration: 0,
        fixedDirection: 0, explodes: 0,
      });
      broadcastEffect(api, api.world, v, fx);
      const dmg = 15 + Math.floor(Math.random() * 11);
      applySpellDamage(api, v, dmg, caster, this);
    }
    ctx.state.sendSystemMessage(`Lightning strikes ${victims.length} target(s).`);
  },
};
