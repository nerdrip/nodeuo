import { broadcastEffect, broadcastSound, applySpellDamage, mobilesNear } from '../../_helpers.js';

// 3s fuse then area damage to everyone within 1 tile of target. We carry the
// detonation inside the status-effects scheduler so spawner/regen loops see
// the same tick cadence; the onRemove callback fires the blast.
export default {
  name: 'explosion',
  // Audit #40 P2 #12 — ServUO `Explosion.cs` → 100% fire damage.
  damageType: { fire: 100 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Explosion needs a target.'); return; }
    const spell = this;
    api.combat.animate(api.world, caster, 0x10);
    const trail = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: caster.serial, to: target.serial,
      itemId: 0x36D4,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 7, duration: 0,
      fixedDirection: 1, explodes: 1,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, trail);
    broadcastSound(api, api.world, target, 0x15E);
    const detonate = () => {
      const tx = target.x, ty = target.y;
      const blast = api.protocol.huedEffect({
        kind: api.protocol.EffectKind.Stationary,
        from: target.serial, to: target.serial,
        itemId: 0x36BD,
        fromX: tx, fromY: ty, fromZ: target.z,
        toX: tx, toY: ty, toZ: target.z,
        speed: 8, duration: 15,
        fixedDirection: 0, explodes: 1,
        hue: 0, renderMode: 0,
      });
      broadcastEffect(api, api.world, target, blast);
      broadcastSound(api, api.world, target, 0x208);
      for (const m of mobilesNear(api, target, 1)) {
        const dmg = 15 + Math.floor(Math.random() * 11);
        applySpellDamage(api, m, dmg, caster, spell);
      }
    };
    if (api.statusEffects?.apply) {
      api.statusEffects.apply(target, {
        name: 'explosion-fuse', durationMs: 3000,
        onRemove() { detonate(); },
      });
    } else {
      setTimeout(detonate, 3000);
    }
  },
};
