import { broadcastSound, expireSummonedMobile } from '../_helpers.js';
export default {
  name: 'summon-fiend', school: 'spellweaving', circle: 2, mana: 32,
  cast(api, ctx) {
    const c = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Summoning unavailable.');
    const kind = api.monsters?.get?.('arcane-fiend') ? 'arcane-fiend' : 'skeleton';
    const fiend = factory(api.world, kind, { x: c.x + 1, y: c.y, z: c.z, map: c.map });
    if (!fiend) return ctx.state.sendSystemMessage('The fiend refuses to come.');
    fiend.controlMaster = c.serial >>> 0; fiend.notoriety = 1;
    fiend.servuoClass ??= 'ArcaneFiend';
    fiend.servuoClasses = [...new Set([...(fiend.servuoClasses ?? []), 'ArcaneFiend'])];
    api.ai?.attach?.(fiend, 'pet', { command: 'follow', targetSerial: 0 });
    broadcastSound(api, api.world, c, 0x217);
    expireSummonedMobile(api, fiend, 120_000);
  },
};
