// Magery `Heal` (id 4, circle 1) — heals a target mobile.
// Mirrors ServUO `Scripts/Spells/First/Heal.cs`. CUO heal targets the
// caster by default but accepts a friendly mobile pick; on a poisoned
// target the heal is HALVED at level 0..2 and FAILS at level 3+.

import { broadcastEffect, broadcastSound, healthUpdateFor } from '../../_helpers.js';
import { flagBeneficialOnCriminal } from '../../../_notoriety.js';

export default {
  name: 'heal',
  // ServUO canonical mana cost for circle-1 spells.
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    // cast.js passes the resolved Mobile as the 3rd arg when
    // `needsTarget: true`. Fallback to the caster so a missing
    // target (test harness, no-pick auto-self) still heals.
    const target = picked ?? caster;
    let heal = 4 + Math.floor(Math.random() * 4) + Math.floor((ctx.skill ?? 0) / 12); // ~4..15
    // Audit #40 P2 #7 — AOS-era ServUO `Heal.cs:53-55` refuses the heal
    // OUTRIGHT when poisoned or Mortal-Struck, regardless of poison
    // level (the half-heal was the pre-AOS rule). Matches what Greater
    // Heal already does (audit #35 P2 #10).
    if (target.poisoned || (target._mortalStrikeUntil ?? 0) > Date.now()) {
      ctx.state.sendSystemMessage('You cannot heal that target in their current state.');
      broadcastSound(api, api.world, caster, 0x01F2);
      return;
    }
    target.hp = Math.min(target.hpMax ?? 50, (target.hp ?? 0) + heal);
    // Audit #35 P2 #9 — flag caster criminal when healing a red/grey.
    try { flagBeneficialOnCriminal(api, caster, target); }
    catch { /* notoriety helper not bundled in test harness */ }
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
    broadcastSound(api, api.world, caster, 0x01F2);
    if (target.client) target.client.send(healthUpdateFor(api, target));
    if (caster !== target && caster.client) caster.client.send(healthUpdateFor(api, target));
    ctx.state.sendSystemMessage(
      target === caster
        ? `You heal yourself for ${heal}.`
        : `You heal ${target.name ?? 'them'} for ${heal}.`,
    );
  },
};
