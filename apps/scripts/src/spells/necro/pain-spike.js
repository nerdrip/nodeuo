// Pain Spike — Necromancy direct-damage spell.
//
// ServUO: 1d8 + skill/3 damage, scales with SpiritSpeak. We use a flat
// random damage with a Necromancy skill bonus so the spell stays useful
// across the full 0..120 skill curve without a separate Eval-Int analog.

import { broadcastEffect, broadcastSound, projectile, skillValue } from '../_helpers.js';
import { mobileBySerial } from '../../_entities.js';

export default {
  name: 'pain-spike',
  school: 'necromancy',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Pain Spike needs a target.');
      return;
    }
    // Audit #36 P2 #7 — ServUO `PainSpike.ApplyEffects:85-118`:
    //   dmg = max(1, (SS − MR)/10 + (player ? 18 : 30))
    // If `target._painSpikeUntil > now` (re-cast within 10 s):
    //   dmg = 3..7 + extend timer by 2 s (the "chain")
    // After 10 s the timer ends and `dmg` is REFUNDED to target.hp
    // (if alive). Also leeches via AOS hit-leech-* attributes.
    // Audit #41 P1 #3 — SpiritSpeak is skill 33 (skill 32 = Archery).
    // 27 = MagicResist (correct).
    const ss = skillValue(caster, 33);
    const mr = skillValue(target, 27);
    const now = Date.now();
    const isChain = (target._painSpikeUntil ?? 0) > now;
    let dmg;
    if (isChain) {
      dmg = 3 + Math.floor(Math.random() * 5);
      target._painSpikeUntil += 2000;
    } else {
      const base = Math.floor((ss - mr) / 10) + (target.client ? 18 : 30);
      dmg = Math.max(1, base);
      target._painSpikeUntil = now + 10_000;
    }
    api.combat.animate(api.world, caster, 0x10);
    const fx = projectile(api, caster, target, { itemId: 0x36F4, hue: 0x047E });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, target, 0x0211);
    const targetSerial = target.serial >>> 0;
    api.combat.damage(api.world, target, dmg, caster);
    api.combat.animate(api.world, target, 0x14, { frameCount: 3 });
    // Refund — ServUO restores `damage` HP after the timer expires
    // (if target still alive). Schedule once for the original cast.
    if (!isChain) {
      const refundDmg = dmg;
      setTimeout(() => {
        const tgt = mobileBySerial(api, targetSerial);
        if (!tgt || (tgt.hp ?? 0) <= 0) return;
        tgt.hp = Math.min(tgt.hpMax ?? 100, (tgt.hp ?? 0) + refundDmg);
        if (tgt.client && api.protocol.healthUpdate) {
          tgt.client.send(api.protocol.healthUpdate({
            serial: tgt.serial, current: tgt.hp, max: tgt.hpMax ?? 50,
          }));
        }
        tgt._painSpikeUntil = 0;
      }, 10_000).unref?.();
    }
  },
};
