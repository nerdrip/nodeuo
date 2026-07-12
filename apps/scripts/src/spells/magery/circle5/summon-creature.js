import { broadcastSound } from '../../_helpers.js';
import { destroyMobileBySerial } from '../../../_mobiles.js';

// Summon Creature — picks a random low-tier critter and spawns it as
// a temporary pet at the caster's side. Despawns after 2 minutes
// (UO retail summon timer baseline). Mirrors the spellweaving
// summon-fey path which already works against `api.ctx.spawnFactory`.
const SUMMON_CHOICES = ['horse', 'cow', 'bull', 'rat', 'cat', 'dog', 'sheep', 'pig'];

export default {
  name: 'summon-creature',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x215);
    const factory = api.ctx?.spawnFactory;
    if (!factory) {
      ctx.state.sendSystemMessage('Summoning is unavailable on this shard.');
      return;
    }
    const kind = SUMMON_CHOICES[Math.floor(Math.random() * SUMMON_CHOICES.length)];
    const spot = { x: caster.x + 1, y: caster.y, z: caster.z, map: caster.map ?? 1 };
    const mob = factory(api.world, kind, spot);
    if (!mob) {
      ctx.state.sendSystemMessage('Your summoning fails to take form.');
      return;
    }
    mob.controlMaster = caster.serial >>> 0;
    mob.controlled = true;
    mob.controlOrder = 'follow';
    mob.controlTarget = caster.serial >>> 0;
    mob.team = caster.serial >>> 0;
    mob.tameable = true;
    mob.tamable = true;
    mob.notoriety = 1;                                  // friendly
    mob.summoned = true;
    mob.summonedBy = caster.serial >>> 0;
    mob._followerCost = Math.max(1, mob.controlSlots | 0);
    caster.followers = (caster.followers | 0) + mob._followerCost;
    api.ai?.attach?.(mob, 'pet', { command: 'follow', targetSerial: caster.serial });
    ctx.state.sendSystemMessage(`You summon ${kind === 'cat' ? 'a cat' : `a ${kind}`}.`);
    setTimeout(() => {
      // Audit #41 P1 #10 — raw `mobiles.delete` leaks reverse parent
      // index, sectors, party/aggressor pointers, follower-slot. Use
      // the canonical `destroyMobile` path (matches summon-helpers).
      try { destroyMobileBySerial(api, mob.serial); }
      catch { /* gone */ }
      caster.followers = Math.max(0, (caster.followers | 0) - (mob._followerCost | 0));
      caster.client?.sendSystemMessage?.('Your summoned creature returns to the ether.');
    }, 120_000).unref?.();
  },
};
