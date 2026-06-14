import { broadcastSound, expireSummonedMobile } from '../_helpers.js';
export default {
  name: 'animated-weapon', school: 'mysticism', circle: 3, mana: 11,
  cast(api, ctx) {
    const c = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Animation unavailable.');
    const minion = factory(api.world, 'animated-weapon', { x: c.x + 1, y: c.y, z: c.z, map: c.map });
    if (!minion) return ctx.state.sendSystemMessage('The weapon refuses to rise.');
    minion.controlMaster = c.serial >>> 0; minion.notoriety = 1;
    api.ai?.attach?.(minion, 'pet', { command: 'guard', targetSerial: 0 });
    broadcastSound(api, api.world, c, 0x217);
    expireSummonedMobile(api, minion, 90_000);
  },
};
