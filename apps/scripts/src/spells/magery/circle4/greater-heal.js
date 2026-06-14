// Magery `Greater Heal` (id 47, circle 4) — full heal of a target.
// Mirrors ServUO `Scripts/Spells/Fourth/GreaterHeal.cs`. Same poison
// gating as plain Heal: level 0..2 halves the heal, level 3+ fails.

import { broadcastEffect, broadcastSound, healthUpdateFor } from '../../_helpers.js';
import { flagBeneficialOnCriminal } from '../../../_notoriety.js';

export default {
  name: 'greater-heal',
  // ServUO canonical mana cost for circle-4 spells.
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    const target = picked ?? caster;
    let heal = 16 + Math.floor(Math.random() * 4) + Math.floor((ctx.skill ?? 0) / 10); // ~16..30
    // Audit #35 P2 #10 — ServUO `GreaterHeal.cs:54-57` fails outright
    // on poisoned OR Mortal-Struck target (no half-heal). Was halving
    // at poison level 0..2 and only failing at 3+. Mortal Strike bypass
    // was entirely missing — defenders could be top-healed mid-MS.
    if (target.poisoned || (target._mortalStrikeUntil ?? 0) > Date.now()) {
      ctx.state.sendSystemMessage('You cannot heal that target while it is poisoned or wounded.');
      broadcastSound(api, api.world, caster, 0x0202);
      return;
    }
    target.hp = Math.min(target.hpMax ?? 50, (target.hp ?? 0) + heal);
    // Audit #35 P2 #9 — beneficial-on-criminal flag.
    try { flagBeneficialOnCriminal(api, caster, target); }
    catch { /* helper not bundled in test harness */ }
    api.combat.animate(api.world, caster, 0x11);
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
    broadcastSound(api, api.world, caster, 0x0202);
    if (target.client) target.client.send(healthUpdateFor(api, target));
    if (caster !== target && caster.client) caster.client.send(healthUpdateFor(api, target));
    ctx.state.sendSystemMessage(
      target === caster
        ? `You heal yourself for ${heal}.`
        : `You heal ${target.name ?? 'them'} for ${heal}.`,
    );
  },
};
