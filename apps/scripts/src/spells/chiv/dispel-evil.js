// Dispel Evil — Chivalry AOE. Audit #42 P2 #19 — full ServUO
// `DispelEvil.cs:78-140` 3-effect rewrite:
//   (a) `Summoned && !IsAnimatedDead` creatures → roll dispel chance
//       = `(50 + 100*(chiv - DispelDifficulty)/(Focus*2)) / 100`,
//       on success `destroyMobile`.
//   (b) Karma<0 unowned creatures → fleeChance roll, on success
//       BeginFlee 30s (we approximate with `_fleeingUntil` flag).
//   (c) Mobiles under a Necromancer transformation (`*FormUntil`)
//       → drain `5 * chiv/100` stam + mana with chance
//       `0.5 * Chiv/Necro`.
// Was: pure damage AOE that even hit own summons.

import { aura, broadcastEffect, broadcastSound, mobilesNear, skillValue } from '../_helpers.js';
import { destroyMobileBySerial } from '../../_mobiles.js';

const RADIUS = 8;

function isUnderNecroTransform(m) {
  const now = Date.now();
  return (m.lichFormUntil ?? 0) > now
      || (m.vampireFormUntil ?? 0) > now
      || (m.wraithFormUntil ?? 0) > now
      || (m.horrificBeastUntil ?? 0) > now;
}

export default {
  name: 'dispel-evil',
  school: 'chivalry',
  cast(api, ctx) {
    const caster = ctx.sender;
    const fx = aura(api, caster, { itemId: 0x373A, hue: 0x4F2, duration: 30 });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x299);

    const chiv = skillValue(caster, 52);
    let dispelled = 0, fled = 0, drained = 0;

    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      if ((m.hp ?? 0) <= 0 || m.ghost) continue;
      const noto = m.notoriety ?? 1;
      if (noto === 1 || noto === 2) continue;

      // (a) summoned (and NOT animated-dead) → roll dispel
      if (m.summoned && !m._animatedDead) {
        const diff  = m.dispelDifficulty ?? 90;
        const focus = m.dispelFocus ?? 30;
        const chance = (50 + (100 * (chiv - diff)) / (focus * 2)) / 100;
        if (Math.random() < chance) {
          try { destroyMobileBySerial(api, m.serial); }
          catch { /* already dispelled */ }
          dispelled++;
          continue;
        }
      }

      // (c) Necro-transformed → drain stam/mana
      if (isUnderNecroTransform(m)) {
        const drainChance = 0.5 * chiv / Math.max(1, skillValue(m, 50) || 100);
        if (Math.random() < drainChance) {
          const drain = Math.floor(5 * chiv / 100);
          m.stam = Math.max(0, (m.stam ?? 0) - drain);
          m.mana = Math.max(0, (m.mana ?? 0) - drain);
          drained++;
        }
        continue;
      }

      // (b) karma<0 unowned → flee
      if (!m.controlMaster && (m.karma ?? 0) < 0) {
        if (Math.random() < 0.7) {
          m._fleeingUntil = Date.now() + 30_000;
          fled++;
        }
      }
    }
    ctx.state.sendSystemMessage(
      `Evil is rebuked. ${dispelled} dispelled, ${fled} fled, ${drained} drained.`);
  },
};
