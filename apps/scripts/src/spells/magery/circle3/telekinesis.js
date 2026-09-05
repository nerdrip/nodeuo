import { broadcastEffect, broadcastSound } from '../../_helpers.js';
import { childrenOf } from '../../../_inventory.js';
import { itemBySerial } from '../../../_entities.js';

// Remote item activation. It uses the same template/script dispatcher as a
// double-click, while retaining the locked/trapped-container safety gates.
export default {
  name: 'telekinesis',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target) { ctx.state.sendSystemMessage('Telekinesis needs a target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x376A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, caster, fx);
    broadcastSound(api, api.world, caster, 0x1F5);
    // Audit #36 P3 #15 — ServUO `Telekinesis.cs:44-76`: invoke the target's
    // telekinesis/use behavior, with a generic distant-container fallback.
    // Refuse on mobiles (the spell only acts on items).
    const itemSerial = target.serial >>> 0;
    const item = itemBySerial(api, itemSerial);
    if (!item || itemSerial === caster.serial) {
      ctx.state.sendSystemMessage('That cannot be manipulated.');
      return;
    }
    if (item.locked) {
      ctx.state.sendSystemMessage('It is locked.');
      return;
    }
    // Do not make the spell a trap bypass. Raw container traps require the
    // normal double-click path so damage and ownership are attributed.
    if (item.trapped || (item._magicTrapDmg | 0) > 0 || (item.trapPower | 0) > 0) {
      ctx.state.sendSystemMessage('A trap prevents you from opening it safely at a distance.');
      return;
    }
    if (api.templates?.useItem?.(api.world, item, caster)) {
      ctx.state.sendSystemMessage('You manipulate the distant object.');
      return;
    }
    if (item.gumpId) {
      // Use the canonical item-open path: send displayContainer +
      // contents to the caster's client. Mirrors `handleUseReq` for
      // containers (server/net/handlers.js `handleUseReq` ~L2855).
      if (caster.client && api.protocol?.displayContainer) {
        caster.client.send(api.protocol.displayContainer(item.serial, item.gumpId));
        // Fetch contents via reverse parent index.
        const contents = [];
        for (const it of childrenOf(api, item)) {
          contents.push({
            serial: it.serial, itemId: it.itemId, amount: it.amount ?? 1,
            hue: it.hue ?? 0, gridX: it.gridX ?? 0, gridY: it.gridY ?? 0,
            gridLocation: 0, parent: item.serial,
          });
        }
        if (api.protocol?.containerContents) {
          caster.client.send(api.protocol.containerContents(item.serial, contents));
        }
        // Mark as "open" so subsequent drag/lift works.
        caster.client.openContainers?.add?.(item.serial);
      }
      ctx.state.sendSystemMessage('You open the distant container.');
      return;
    }
    ctx.state.sendSystemMessage('You extend your will outward.');
  },
};
