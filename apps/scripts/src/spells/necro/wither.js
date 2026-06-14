// Wither — Necromancy AOE: damages every non-undead within 5 tiles of
// the caster. Caster gets a brief healing aura because the soul-energy
// returned to them tops up HP slightly. Mirrors ServUO `WitherSpell.cs`
// with simplified resist handling.

import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';

const RADIUS = 5;

export default {
  name: 'wither',
  school: 'necromancy',
  cast(api, ctx) {
    const caster = ctx.sender;
    const fx = aura(api, caster, { itemId: 0x37CC, hue: 0x015, duration: 30 });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x01FB);

    // Audit #38 P1 #4 — ServUO `Wither.cs:69-116` formula:
    //   base = RandomMinMax(30, 35)
    //   dmg  = floor(base * (300 + (Karma|0)/100 + SS*10) / 1000)
    //   damaged as 100% cold (bypasses physical resist).
    // Was: `12 + necro/8` (12..27) — half ServUO's output, untyped.
    // Skill 32 = SpiritSpeak (ServUO `DamageSkill`).
    // Audit #41 P1 #3 — Spirit Speak is skill id 33 (32 = Archery).
    // Audit #42 P1 #20 — `??` only catches null/undefined; if `[33]=0`
    // literal it returned 0 instead of falling to Necromancy. Use `||`
    // so a fresh mob with skill=0 falls through to the Necro reading.
    const ss = skillValue(caster, 33) || skillValue(caster, 50);
    const karma = caster.karma ?? 0;
    let hits = 0;
    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      // Only damage hostiles — same notoriety filter the existing AOE
      // spells use (matches ServUO `IsHarmfulCriteria`).
      const noto = m.notoriety ?? 1;
      if (noto === 1 || noto === 2) continue;
      const base = 30 + Math.floor(Math.random() * 6);                // 30..35
      const dmg  = Math.max(1, Math.floor(base * (300 + karma / 100 + ss * 10) / 1000));
      api.combat.damage(api.world, m, dmg, caster, { cold: 100 });
      api.combat.animate(api.world, m, 0x14, { frameCount: 3 });
      hits++;
    }
    if (hits > 0) {
      const heal = 2 * hits;
      caster.hp = Math.min(caster.hpMax ?? 50, (caster.hp ?? 0) + heal);
      if (caster.client) {
        caster.client.send(api.protocol.healthUpdate({
          serial: caster.serial, current: caster.hp, max: caster.hpMax ?? 50,
        }));
      }
    }
    ctx.state.sendSystemMessage(`Wither strikes ${hits} ${hits === 1 ? 'creature' : 'creatures'}.`);
  },
};
