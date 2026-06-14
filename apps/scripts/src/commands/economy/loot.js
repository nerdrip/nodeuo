// `[loot` / `[loot all` — sweep loot from the nearest corpse in reach.
//
// Classic-UO shortcut is alt+dblclick on the corpse; the client maps that
// to `[loot`. Default mode sweeps gold only (the common QoL case). With
// the `all` argument we also reparent every other movable child into the
// player's backpack and fire 0x25
// ContainerContentUpdate so the backpack gump updates if it's open.
//
// Non-movable items are skipped (bones, static body parts, etc.).

import { allMobiles, allItems } from '../../_spatial.js';
import { destroyItemBySerial } from '../../_items.js';
import { moveItem } from '../../_movement.js';

const CORPSE_ITEM_ID = 0x2006;
const GOLD_ITEM_ID   = 0x0EED;
const LOOT_RANGE     = 3;

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.protocol?.removeEntity || !api.protocol?.containerContentUpdate) {
    api.log('commands/loot: protocol helpers missing; skipping');
    return () => {};
  }
  const { world, commands, protocol } = api;

  function broadcastRemove(serial) {
    const pkt = protocol.removeEntity(serial);
    for (const m of allMobiles({ world })) {
      if (m.client) m.client.send(pkt);
    }
  }

  /** Pick the closest corpse within LOOT_RANGE and on the same map. */
  function findCorpse(mob) {
    let best = null;
    let bestDist = LOOT_RANGE + 1;
    for (const it of allItems({ world })) {
      if (it.itemId !== CORPSE_ITEM_ID) continue;
      if (it.map !== mob.map) continue;
      const d = Math.max(Math.abs(it.x - mob.x), Math.abs(it.y - mob.y));
      if (d < bestDist) { bestDist = d; best = it; }
    }
    return best;
  }

  commands.register({
    name: 'loot',
    help: '[loot [all] — sweep gold (or everything) from the nearest corpse',
    run(ctx, args) {
      const state = ctx.state;
      const mob = ctx.sender;
      if (!state?.mobile || !mob) return;
      const sweepAll = (args[0] ?? '').toLowerCase() === 'all';

      const corpse = findCorpse(mob);
      if (!corpse) {
        state.sendSystemMessage('No corpse within reach.');
        return;
      }

      let gold = 0;
      let goldStacks = 0;
      let itemsMoved = 0;
      const pack = sweepAll ? api.game?.inventory?.findBackpack?.(mob) : null;
      for (const child of [...allItems({ world })]) {
        if (child.parent !== corpse.serial) continue;
        if (child.itemId === GOLD_ITEM_ID) {
          gold += child.amount | 0;
          goldStacks += 1;
          try { destroyItemBySerial({ world }, child.serial); }
          catch { /* already looted */ }
          broadcastRemove(child.serial);
          continue;
        }
        if (!sweepAll) continue;
        if (child.movable === false) continue;
        if (!pack) continue;
        // Reparent to the actual backpack. Use moveItem so the reverse
        // `_childrenByParent` index follows.
        const gridX = 60 + ((Math.random() * 80) | 0);
        const gridY = 60 + ((Math.random() * 60) | 0);
        moveItem(api, child, { parent: pack.serial, x: gridX, y: gridY, z: 0 });
        child.gridX = gridX; child.gridY = gridY; child.gridLocation = 0;
        itemsMoved += 1;
        // Drop it from any still-open corpse gump, then slot it into the
        // mover's backpack on their own client.
        broadcastRemove(child.serial);
        if (mob.client) {
          mob.client.send(protocol.containerContentUpdate({
            serial: child.serial, itemId: child.itemId,
            amount: child.amount, hue: child.hue ?? 0,
            gridX, gridY, gridLocation: 0,
          }, pack.serial));
        }
      }

      if (gold <= 0 && itemsMoved === 0) {
        state.sendSystemMessage(sweepAll ? 'There is nothing here.' : 'There is no gold here.');
        return;
      }
      if (gold > 0) mob.gold = (mob.gold ?? 0) + gold;

      const parts = [];
      if (gold > 0) parts.push(`${gold} gold${goldStacks > 1 ? ` (${goldStacks} piles)` : ''}`);
      if (itemsMoved > 0) parts.push(`${itemsMoved} item${itemsMoved === 1 ? '' : 's'}`);
      state.sendSystemMessage(`You loot ${parts.join(' and ')}. Purse: ${mob.gold ?? 0}.`);
    },
  });

  return () => {
    commands.unregister('loot');
  };
}
