import { broadcastEffect, broadcastSound, magerySkill, applySpellDamage, skillValue } from '../../_helpers.js';
import { applyPoison } from '../../../_poison.js';

const SKILL_POISONING = 31;

export default {
  name: 'poison',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Poison needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: caster.serial, to: target.serial,
      itemId: 0x36D4,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 7, duration: 0,
      fixedDirection: 1, explodes: 0,
      hue: 0x40, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x205);
    // Audit #40 P1 #3 — ServUO `Poison.cs:114` routes through
    // `Mobile.ApplyPoison` which writes the canonical `poisoned`/
    // `poisonLevel` fields. Was: custom status-effects ticker named
    // 'poison' that never set `target.poisoned`, so Cure / Arch Cure /
    // GHeal poison-gate / Mortal Strike combo / Strangle "stop while
    // poisoned" gate ALL saw the target as unpoisoned.
    // Level = (Magery + Poisoning) / 2 → ServUO tiers:
    //   ≥100 → Deadly (3), >85 → Greater (2), >65 → Regular (1),
    //   else Lesser (0).
    const mag  = magerySkill(caster);
    const pois = skillValue(caster, SKILL_POISONING);
    const avg  = (mag + pois) / 2;
    const level = avg >= 100 ? 3 : avg > 85 ? 2 : avg > 65 ? 1 : 0;
    if (!applyPoison(api, target, level, caster)) {
      // Falls back to raw damage when poison module is absent (test
      // stubs without world wiring). Preserves prior behaviour.
      if (!api.statusEffects) {
        applySpellDamage(api, target, 3, caster, this);
      }
    }
    api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
  },
};
