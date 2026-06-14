import { broadcastEffect, broadcastSound, magerySkill, SKILL_EVAL_INT, SKILL_RESIST, skillValue } from '../../_helpers.js';

export default {
  name: 'paralyze',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Paralyze needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x376A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0x480, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x204);
    if (!api.statusEffects) return;
    // Audit #30 P2 #5 — ServUO `Paralyze.cs::OnTarget`:
    //   secs = (EvalInt − MagicResist) / 10
    //   non-players: ×3
    //   capped low at 0, hard cap 12 s for players
    // Previously paralyze was `6_000 + skill * 140` ms with no Resist
    // factor — a 100-Magery caster perma-locked a 120-resist target.
    // Fall back to Magery when the caster has no EvalInt at all so we
    // don't completely lock out low-tier casters from the spell —
    // matches ServUO's `damageBonus = Spell.GetDamageScalar` fallback.
    const evalInt = skillValue(caster, SKILL_EVAL_INT) || magerySkill(caster);
    const resist  = skillValue(target, SKILL_RESIST);
    let secs = Math.floor((evalInt - resist) / 10);
    if (secs <= 0) {
      ctx.state.sendSystemMessage('The spell appears to have no effect.');
      return;
    }
    if (!target.client) secs *= 3;
    let durationMs = secs * 1000;
    if (target.client) durationMs = Math.min(12_000, durationMs);
    api.statusEffects.apply(target, { name: 'paralyze', durationMs });
  },
};
