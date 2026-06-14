import { broadcastSound, clientsNear, itemsNear } from '../../_helpers.js';
import { destroyItemBySerial } from '../../../_items.js';

// Dispel Field — destroy any spell-field tile within 1 of the target.
// Now wired against the field pipeline introduced in
// `spells/_field-helpers.js` (script name 'spell-field').
export default {
  name: 'dispel-field',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x201);
    if (!picked) { ctx.state.sendSystemMessage('Dispel Field needs a tile target.'); return; }
    const target = picked.entity ?? picked;
    const tx = target.x | 0, ty = target.y | 0;
    const tmap = target.map ?? caster.map ?? 1;
    let dispelled = 0;
    /** @type {number[]} */
    const victims = [];
    const center = { x: tx, y: ty, z: target.z ?? caster.z ?? 0, map: tmap };
    for (const it of itemsNear(api, center, 1)) {
      if (it.script !== 'spell-field') continue;
      victims.push(it.serial);
    }
    for (const s of victims) {
      try {
        if (api.protocol?.removeEntity) {
          const pkt = api.protocol.removeEntity(s);
          if (api.query?.sendToClientsNear) {
            api.query.sendToClientsNear(center, pkt, 18);
          } else {
            for (const m of clientsNear(api, api.world, center, 18)) {
              m.client.send(pkt);
            }
          }
        }
        destroyItemBySerial(api, s);
        dispelled++;
      } catch { /* best-effort */ }
    }
    ctx.state.sendSystemMessage(
      dispelled > 0
        ? `You disperse ${dispelled} field tile${dispelled === 1 ? '' : 's'}.`
        : 'No field to disperse there.',
    );
  },
};
