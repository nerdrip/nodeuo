import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';

export default {
  name: 'invisibility',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    // ServUO `InvisibilitySpell.cs::OnTarget` defaults to the caster
    // when the targeted mobile is the caster themselves — and the
    // server-side `effect()` wrapper passes whatever `target` arrived
    // off the cast packet, which may be empty for the self-cast macro
    // (no targeting prompt fired). Fall through to caster so a
    // hotbar-bound [cast Invisibility doesn't no-op silently. Test
    // path (`def.effect({caster})`) also relies on this fallback.
    if (!target || !target.serial) target = caster;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Invisibility needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x376A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x203);
    // Audit #36 P2 #10 — ServUO `InvisibilitySpell.cs:65-83`: duration
    // = `1.2 * Magery * 100` ms (12 s @ skill 0, 144 s @ skill 120).
    // Also clears Combatant and WarMode so the freshly invisible
    // target doesn't auto-swing themselves out of stealth.
    const magery = skillValue(caster, 26);
    const durationMs = Math.max(12_000, Math.floor(1.2 * magery * 100));
    target.hidden = true;
    // ServUO `InvisibilitySpell.cs:81` — `target.AllowedStealthSteps = 5`.
    // Without this the hidden mob is broken by their very first step
    // (Stealth.cs gates on `stealthSteps > 0`).
    target.stealthSteps = 5;
    target.combatant = 0;
    target.warMode = false;
    // Clear war flag on the wire-side flag byte too (0x40 = WarMode).
    if (typeof target.flags === 'number') target.flags = target.flags & ~0x40;
    if (api.statusEffects) {
      api.statusEffects.apply(target, {
        name: 'invisibility',
        durationMs,
        onRemove(mob) { mob.hidden = false; },
      });
    }
  },
};
