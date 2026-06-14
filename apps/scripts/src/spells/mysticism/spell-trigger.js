// Spell Trigger — store a spell on a wand-class item in the caster's
// pack. ServUO behaviour: the next time the caster *uses* the wand
// (double-click), the stored spell fires (no mana, no reagent cost).
// We approximate by stamping `_storedSpell` on the wand; the wand's
// onUse handler reads it and calls cast.
//
// For now we hardcode the stored spell to the next spell the caster
// casts via [cast — at cast time, if `_pendingSpellTrigger` is set,
// stamp the spell name onto the wand and clear the pending flag.
//
// The trigger consumes the stored spell on use (single-shot).

import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
import { findInPack } from '../../_inventory.js';

const WAND_ITEM_IDS = new Set([
  0x0DF2, 0x0DF3, 0x0DF4, 0x0DF5, 0x0E89, 0x0E8A,   // Heal/lightning/fire/MA/cure/clumsy
]);

export default {
  name: 'spell-trigger', school: 'mysticism', circle: 5, mana: 14,
  cast(api, ctx) {
    const m = ctx.sender;
    // Find the first wand in the caster's pack to receive the trigger.
    const wand = findInPack(api, m, (it) => WAND_ITEM_IDS.has(it.itemId | 0));
    if (!wand) {
      ctx.state.sendSystemMessage('You need a wand in your pack to inscribe with a spell trigger.');
      return;
    }
    // Mark the next spell cast to attach to this wand.
    m._pendingSpellTrigger = wand.serial;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x4FE }));
    broadcastSound(api, api.world, m, 0x659);
    api.statusEffects?.apply?.(m, { name: 'spell-trigger', durationMs: 600_000 });
    ctx.state.sendSystemMessage('Cast the spell you wish to store on the wand.');
  },
};
