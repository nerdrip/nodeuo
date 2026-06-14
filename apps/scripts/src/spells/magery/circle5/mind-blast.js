import { broadcastEffect, broadcastSound, applySpellDamage, skillValue } from '../../_helpers.js';

export default {
  name: 'mind-blast',
  // Audit #40 P2 #12 — ServUO `MindBlast.cs:122` → 100% cold damage.
  damageType: { cold: 100 },
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Mind blast needs a target.'); return; }
    // Audit #38 P2 #7 — ServUO AOS `MindBlast.cs:80-116`:
    //   damage = (Magery + min(200, Int))/5 + RandomMinMax(2, 6)
    //   hard-capped at 60.
    // Was: flat 12..20 — a 0-Int apprentice and a 120-Int archmage
    // dealt identical damage. Skill 26 = Magery.
    const mag = skillValue(caster, 26);
    const intel = Math.min(200, caster.int ?? 0);
    const dmg = Math.min(60,
      Math.floor((mag + intel) / 5) + 2 + Math.floor(Math.random() * 5));
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x374A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0x14, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x213);
    applySpellDamage(api, target, dmg, caster, this);
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
