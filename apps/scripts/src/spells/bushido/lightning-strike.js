// Lightning Strike — Bushido offensive ability that primes the samurai's
// next melee swing for a guaranteed crit. ServUO uses
// `Engines/Bushido/LightningStrike.cs`. We tag a single-use status-effect
// the combat tick can read; for MVP the buff just expires after 5s with
// no consumption hook, so it's currently flavour + visual.

import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';

export default {
  name: 'lightning-strike',
  school: 'bushido',
  cast(api, ctx) {
    const caster = ctx.sender;
    const fx = aura(api, caster, { itemId: 0x379F, hue: 0x47E, duration: 20 });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x20A);
    api.statusEffects?.apply?.(caster, { name: 'lightning-strike', durationMs: 5_000 });
    ctx.state.sendSystemMessage('You ready a lightning-fast strike.');
  },
};
