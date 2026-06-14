import { aura, broadcastEffect, broadcastSound, broadcastBodyChange } from '../_helpers.js';
// Transform into a wolf (body 0xE1) for stealth movement.
export default {
  name: 'animal-form', school: 'ninjitsu', circle: 1, mana: 10,
  cast(api, ctx) {
    const m = ctx.sender;
    if (m._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    m._origBody = m.body; m.body = 0xE1;
    // Audit #41 P2 #22 — `mobileUpdate` only reaches self; observers
    // still saw the human body until the next movement packet. Use
    // the shared body-change broadcaster.
    try { broadcastBodyChange(api, api.world, m); }
    catch {
      if (m.client && api.protocol?.mobileUpdate) m.client.send(api.protocol.mobileUpdate({
        serial: m.serial, body: m.body, hue: m.hue, flags: m.flags,
        x: m.x, y: m.y, z: m.z, direction: m.direction,
      }));
    }
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x3779, hue: 0x76 }));
    broadcastSound(api, api.world, m, 0x216);
    api.statusEffects?.apply?.(m, {
      name: 'animal-form', durationMs: 120_000,
      onRemove(mob) { if (mob._origBody != null) { mob.body = mob._origBody; delete mob._origBody; } },
    });
  },
};
