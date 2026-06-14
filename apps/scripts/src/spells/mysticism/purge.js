import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
const CURSES = ['curse', 'corpse-skin', 'evil-omen', 'mind-rot', 'strangle', 'blood-oath', 'poison'];
export default {
  name: 'purge', school: 'mysticism', circle: 2, mana: 6,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Purge needs a target.');
    let cleansed = 0;
    for (const name of CURSES) if (api.statusEffects?.has?.(target, name)) {
      api.statusEffects.remove(target, name); cleansed++;
    }
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x373A, hue: 0x4FE }));
    broadcastSound(api, api.world, target, 0x655);
    ctx.state.sendSystemMessage(cleansed ? `Purged ${cleansed} affliction(s).` : 'Nothing to purge.');
  },
};
