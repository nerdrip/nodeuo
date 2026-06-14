import { broadcastEffect, broadcastSound } from '../../_helpers.js';
import { childrenOf, findBackpack } from '../../../_inventory.js';

export default {
  name: 'create-food',
  cast(api, ctx) {
    const caster = ctx.sender;
    // FX is best-effort. Wrap so a missing huedEffect / animate API
    // can never abort the bread mint below — earlier reports of
    // "create food gives no bread" traced to an FX path throwing on
    // older API revisions and the createItem call never running.
    try {
      api.combat?.animate?.(api.world, caster, 0x11);
      if (api.protocol?.huedEffect && api.protocol?.EffectKind) {
        const fx = api.protocol.huedEffect({
          kind: api.protocol.EffectKind.FromSource,
          from: caster.serial, to: caster.serial,
          itemId: 0x373A,
          fromX: caster.x, fromY: caster.y, fromZ: caster.z,
          toX: caster.x, toY: caster.y, toZ: caster.z,
          speed: 10, duration: 15,
          fixedDirection: 0, explodes: 0,
          hue: 0, renderMode: 0,
        });
        broadcastEffect(api, api.world, caster, fx);
      }
      broadcastSound(api, api.world, caster, 0x1E2);
    } catch (e) {
      api.log?.(`create-food fx failed: ${e?.message ?? e}`);
    }

    // Resolve the caster's backpack (layer 21).
    const backpack = findBackpack(api, caster);
    if (!backpack) {
      ctx.state.sendSystemMessage('You have no backpack to hold the food.');
      return;
    }
    // 0x103B = bread loaf. `giveItem` owns the pack placement and the
    // single-item container update; we still push a full 0x3C snapshot
    // below so closed backpack windows see the new bread immediately.
    const item = api.game?.mobile?.giveItem?.(caster, {
      itemId: 0x103B,
      amount: 1,
      movable: true,
    }, { randomGrid: true });
    if (!item) { ctx.state.sendSystemMessage('Item creation failed.'); return; }

    const sender = caster.client ?? ctx.state;
    if (sender?.send) {
      // Keep the full backpack snapshot: older clients sometimes ignore
      // a single 0x25 update when the bag gump was closed.
      if (api.protocol?.containerContents) {
        try {
          const entries = [];
          for (const child of childrenOf(api, backpack)) {
            entries.push({
              serial: child.serial, itemId: child.itemId,
              amount: child.amount ?? 1,
              gridX: child.gridX ?? 0, gridY: child.gridY ?? 0,
              gridLocation: child.gridLocation ?? 0,
              hue: child.hue ?? 0,
            });
          }
          sender.send(api.protocol.containerContents(backpack.serial, entries));
        } catch (e) { api.log?.(`create-food 0x3C send failed: ${e?.message ?? e}`); }
      }
    }
    ctx.state.sendSystemMessage('A loaf of bread appears in your backpack.');
  },
};
