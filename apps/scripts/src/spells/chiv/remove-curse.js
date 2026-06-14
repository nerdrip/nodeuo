// Remove Curse — strips the named curse statuses from a friendly
// target. Mirrors Magery Arch Cure for non-poison debuffs.
import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
const CURSES = ['curse', 'corpse-skin', 'evil-omen', 'mind-rot', 'strangle', 'blood-oath'];
export default {
  name: 'remove-curse', school: 'chivalry', circle: 3, mana: 0,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Remove Curse needs a target.');
    const caster = ctx.sender;
    // Audit #42 P2 #16 — ServUO `RemoveCurse.cs:80-89` rolls karma:
    //   <-5000 → 0%; <0 → sqrt(20000+k) - 122; <5625 → sqrt(k) + 25;
    //   else 100%.
    const karma = caster.karma ?? 0;
    let chance = 0;
    if (karma < -5000) chance = 0;
    else if (karma < 0) chance = Math.max(0, Math.sqrt(20000 + karma) - 122);
    else if (karma < 5625) chance = Math.min(100, Math.sqrt(karma) + 25);
    else chance = 100;
    if (Math.random() * 100 >= chance) {
      broadcastSound(api, api.world, caster, 0x01DF);
      ctx.state.sendSystemMessage('You fail to remove the curse.');
      return;
    }
    let cleansed = 0;
    for (const name of CURSES) {
      if (api.statusEffects?.has?.(target, name)) {
        api.statusEffects.remove(target, name);
        cleansed++;
      }
    }
    // Audit #42 P2 #16 — also clear the canonical PvP debuffs that
    // live outside status-effects: Mortal Strike + Pain Spike.
    if ((target._mortalStrikeUntil ?? 0) > Date.now()) {
      target._mortalStrikeUntil = 0; cleansed++;
    }
    if ((target._painSpikeUntil ?? 0) > Date.now()) {
      target._painSpikeUntil = 0; cleansed++;
    }
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x373A, hue: 0x4F2 }));
    broadcastSound(api, api.world, target, 0x021F);
    ctx.state.sendSystemMessage(cleansed ? `${cleansed} curse(s) lifted.` : 'No curses to remove.');
  },
};
