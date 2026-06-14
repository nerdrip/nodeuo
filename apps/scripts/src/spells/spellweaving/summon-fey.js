import { broadcastSound, expireSummonedMobile } from '../_helpers.js';
export default {
  name: 'summon-fey', school: 'spellweaving', circle: 2, mana: 32,
  cast(api, ctx) {
    const c = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Summoning unavailable.');
    const fey = factory(api.world, 'rat', { x: c.x + 1, y: c.y, z: c.z, map: c.map });
    if (!fey) return ctx.state.sendSystemMessage('The fey refuses to come.');
    fey.controlMaster = c.serial >>> 0; fey.notoriety = 1;
    api.ai?.attach?.(fey, 'pet', { command: 'follow', targetSerial: 0 });
    broadcastSound(api, api.world, c, 0x217);
    expireSummonedMobile(api, fey, 120_000);
  },
};
