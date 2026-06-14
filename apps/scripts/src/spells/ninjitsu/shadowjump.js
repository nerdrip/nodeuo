import { aura, broadcastEffect, broadcastSound } from '../_helpers.js';
import { moveMobile } from '../../_movement.js';
// Teleport short distance and stay hidden.
export default {
  name: 'shadowjump', school: 'ninjitsu', circle: 2, mana: 15,
  cast(api, ctx, picked) {
    if (!picked) return ctx.state.sendSystemMessage('Shadowjump cancelled.');
    const m = ctx.sender;
    const dist = Math.max(Math.abs(picked.x - m.x), Math.abs(picked.y - m.y));
    if (dist > 12) return ctx.state.sendSystemMessage('Too far for a shadowjump.');
    moveMobile(api, m, { x: picked.x, y: picked.y, z: picked.z });
    if (m.client && api.protocol?.mobileUpdate) m.client.send(api.protocol.mobileUpdate({
      serial: m.serial, body: m.body, hue: m.hue, flags: m.flags,
      x: m.x, y: m.y, z: m.z, direction: m.direction,
    }));
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x375A, hue: 0x42 }));
    broadcastSound(api, api.world, m, 0x216);
  },
};
