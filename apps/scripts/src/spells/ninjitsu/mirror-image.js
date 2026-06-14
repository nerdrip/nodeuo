import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
import { destroyMobileBySerial } from '../../_mobiles.js';
// Spawn a duplicate clone (skeleton template) that distracts foes.
export default {
  name: 'mirror-image', school: 'ninjitsu', circle: 2, mana: 20,
  cast(api, ctx) {
    const caster = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Mirror Image unavailable.');
    const clone = factory(api.world, 'rat', { x: caster.x + 1, y: caster.y, z: caster.z, map: caster.map });
    if (!clone) return ctx.state.sendSystemMessage('Your image fails to manifest.');
    clone.body = caster.body; clone.hue = caster.hue;
    clone.controlMaster = caster.serial >>> 0;
    // Audit #42 P2 #28 — ServUO `MirrorImage.cs` tags the clone with
    // the master's notoriety so red/grey casters get red/grey mirrors.
    // Was: hardcoded notoriety=1 (innocent) → AOE filters treated red
    // attacker's mirror as a friendly blue (Dispel Evil refused to
    // target it; ArchCure healed it).
    clone.notoriety = caster.notoriety ?? 1;
    clone.kind = 'illusion';
    api.ai?.attach?.(clone, 'pet', { command: 'guard', targetSerial: 0 });
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x376A, hue: 0x12 }));
    broadcastSound(api, api.world, caster, 0x216);
    // Audit #41 P1 #10 — destroyMobile, not raw map delete.
    setTimeout(() => {
      try { destroyMobileBySerial(api, clone.serial); }
      catch { /* gone */ }
    }, 60_000).unref?.();
  },
};
