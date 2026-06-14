import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';

// Toggle a `disguised` flag on the caster for the duration. Name/hue rerolls
// are punted (depends on the name/paperdoll broadcast pipeline) — the flag
// keeps save-load round-tripping correct in the meantime.
export default {
  name: 'incognito',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
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
    broadcastSound(api, api.world, caster, 0x203);
    caster.disguised = true;
    if (api.statusEffects) {
      // Audit #41 P2 #15 — ServUO `Incognito.cs:127-130`:
      //   duration_s = (6 * Magery / 50) + 1, capped at 144
      // Was: flat 90s — too long at low skill, too short at GM.
      const magery = skillValue(caster, 26);
      const dur = Math.min(144, Math.max(8, Math.floor(6 * magery / 50 + 1))) * 1000;
      api.statusEffects.apply(caster, {
        name: 'incognito',
        durationMs: dur,
        onRemove(mob) { mob.disguised = false; },
      });
    }
    ctx.state.sendSystemMessage('You feel different.');
  },
};
