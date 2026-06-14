import { broadcastSound, expireSummonedMobile } from '../_helpers.js';

// Arcane Summon — port of ServUO `ArcaneSummon.cs` (Spellweaving
// support spell). Brings up a temporary arcane construct that follows
// the caster and aggros on the caster's enemies. Differs from
// summon-fey/-fiend by following the *caster's* current target rather
// than wandering.

export default {
  name: 'arcane-summon', school: 'spellweaving', circle: 3, mana: 24,
  cast(api, ctx) {
    const c = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Summoning unavailable.');
    const construct = factory(api.world, 'arcane-construct',
      { x: c.x + 1, y: c.y, z: c.z, map: c.map });
    if (!construct) return ctx.state.sendSystemMessage('The arcane construct refuses to manifest.');
    construct.controlMaster = c.serial >>> 0;
    construct.notoriety = 1;
    construct.summoned = true;
    // Inherit caster's current target so the construct goes straight
    // for whoever the caster was engaging.
    if (c._currentTarget) construct._currentTarget = c._currentTarget;
    api.ai?.attach?.(construct, 'pet', {
      command: 'attack',
      targetSerial: c._currentTarget ?? 0,
    });
    broadcastSound(api, api.world, c, 0x5BB);
    expireSummonedMobile(api, construct, 90_000);
  },
};
