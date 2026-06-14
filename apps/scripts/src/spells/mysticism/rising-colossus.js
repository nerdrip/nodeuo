import { broadcastSound, expireSummonedMobile } from '../_helpers.js';
export default {
  name: 'rising-colossus', school: 'mysticism', circle: 8, mana: 50,
  cast(api, ctx) {
    const c = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Summoning unavailable.');
    const colossus = factory(api.world, 'ettin', { x: c.x + 1, y: c.y, z: c.z, map: c.map });
    if (!colossus) return ctx.state.sendSystemMessage('The colossus refuses to rise.');
    colossus.controlMaster = c.serial >>> 0; colossus.notoriety = 1;
    colossus.hp = colossus.hpMax = 200;
    api.ai?.attach?.(colossus, 'pet', { command: 'guard', targetSerial: 0 });
    broadcastSound(api, api.world, c, 0x217);
    expireSummonedMobile(api, colossus, 60_000);
  },
};
