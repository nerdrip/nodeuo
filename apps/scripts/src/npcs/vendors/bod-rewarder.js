// FAZA DF — Bulk Order Reward NPC.
//
// ServUO: Scripts/Engines/BulkOrders/BulkOrderHandler.cs has a vendor
// type that turns in completed deeds for ranked rewards (runic tools,
// recipe scrolls, BoD reward cloth, etc.). Our minimal port:
//
//   [bodrewarder           — admin spawn at sender's feet
//   [turninbod             — player command; finds first completed BoD
//                            in the player's pack and grants a reward
//                            scaled to its "points" (quantity × bonus
//                            modifiers).
//
// We deliberately don't model every ServUO reward tier. Three tiers:
//   < 60 points   → gold pile (quantity × 5 gp)
//   60..119 pts   → gold pile + recipe scroll
//   ≥ 120 pts     → gold pile + runic tool (smithy: dull-copper hammer)

import { packItems } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';
import { allMobiles, nearbyClients } from '../../_spatial.js';
import { createMobile } from '../../_mobiles.js';

const REWARDER_BODY = 0x0190;     // human male
const REWARDER_HUE  = 0x044C;     // pale blue uniform
const RECIPE_SCROLL_ITEM = 0x14F0; // scroll graphic
const RUNIC_HAMMER_ITEM  = 0x13E3; // smith hammer (with hue)
const RUNIC_SEWING_KIT   = 0x0F9D; // sewing kit
const GOLD_PILE_ITEM     = 0x0EED;

function bodPoints(bod) {
  if (!bod) return 0;
  if (bod.large) {
    // Large BODs are roughly 2× the value of the slots' base sizes.
    const base = bod.slots.length * 20;
    return Math.round(base
      * (bod.exceptional ? 2 : 1)
      * (bod.material === 'iron' ? 1 : 2));
  }
  let p = bod.quantity | 0;
  if (bod.exceptional) p *= 2;
  if (bod.material && bod.material !== 'iron') p *= 2;
  return p;
}

function rewardFor(bod) {
  const pts = bodPoints(bod);
  const gold = pts * 5;
  if (pts >= 120) {
    const runicItem = bod.skill === 35 ? RUNIC_SEWING_KIT : RUNIC_HAMMER_ITEM;
    return { gold, special: { itemId: runicItem, hue: 0x0973, name: 'runic tool' } };
  }
  if (pts >= 60) {
    return { gold, special: { itemId: RECIPE_SCROLL_ITEM, hue: 0x0481, name: 'recipe scroll' } };
  }
  return { gold, special: null };
}

export default function register(api) {
  if (!api.commands || !api.world || !api.game?.mobile?.giveItem) return () => {};

  api.commands.register({
    name: 'bodrewarder',
    help: '[bodrewarder — spawn a Bulk Order Reward NPC at your feet.',
    access: 'GameMaster',
    run(ctx) {
      const npc = createMobile(api, api.world, {
        name: 'Larissa the Reward Trader',
        body: REWARDER_BODY, hue: REWARDER_HUE,
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
        notoriety: 1, // innocent
      });
      npc.title = 'BOD Reward Trader';
      npc.kind = 'bod-rewarder';
      const incoming = api.protocol?.mobileIncoming?.({
        serial: npc.serial, body: npc.body, x: npc.x, y: npc.y, z: npc.z,
        direction: npc.direction ?? 0, hue: npc.hue,
        flags: npc.flags ?? 0, notoriety: npc.notoriety,
        equipment: [],
      });
      if (incoming) {
        for (const m of nearbyClients(api.world, npc)) m.client.send(incoming);
      }
      ctx.state.sendSystemMessage(`Spawned ${npc.name}.`);
    },
  });

  api.commands.register({
    name: 'turninbod',
    help: '[turninbod — turn in the first completed BoD in your pack.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      // Find a Reward Trader within 4 tiles. Mirror ServUO's "must
      // stand near the vendor" gate so the reward isn't usable as a
      // spawn-and-claim exploit at a distant safehouse.
      let trader = null;
      const traders = api.game?.mobilesNear?.(sender, { range: 4, self: sender })
        ?? api.query?.mobilesNear?.(sender, 4, sender)
        ?? allMobiles(api);
      for (const m of traders) {
        if (m.kind !== 'bod-rewarder') continue;
        if (m.map !== sender.map) continue;
        if (Math.abs(m.x - sender.x) > 4 || Math.abs(m.y - sender.y) > 4) continue;
        trader = m; break;
      }
      if (!trader) {
        ctx.state.sendSystemMessage('You must stand near a Bulk Order Reward Trader.');
        return;
      }
      // Find the first completed BoD in the sender's pack.
      let deed = null;
      for (const it of packItems(api, sender)) {
        const bod = it.bod;
        if (!bod) continue;
        if (bod.large) {
          if (bod.slots.every((s) => s.done)) { deed = it; break; }
        } else if ((bod.progress | 0) >= (bod.quantity | 0)) {
          deed = it; break;
        }
      }
      if (!deed) {
        ctx.state.sendSystemMessage('You have no completed bulk orders in your pack.');
        return;
      }
      const reward = rewardFor(deed.bod);
      if (!api.game.inventory?.findBackpack?.(sender)) {
        ctx.state.sendSystemMessage('You have no backpack for the reward.');
        return;
      }
      // Grant gold.
      if (reward.gold > 0) {
        api.game?.mobile?.giveItem?.(sender, {
          itemId: GOLD_PILE_ITEM,
          amount: reward.gold,
          name: 'gold', movable: true,
        }, { randomGrid: true });
      }
      // Grant special reward if any.
      if (reward.special) {
        api.game?.mobile?.giveItem?.(sender, {
          itemId: reward.special.itemId,
          hue: reward.special.hue ?? 0,
          name: reward.special.name,
          movable: true,
        }, { randomGrid: true });
      }
      // Consume the deed (and its bound small BoDs for large deeds).
      if (deed.bod.large) {
        for (const slot of deed.bod.slots) {
          if (slot.smallBodSerial) destroyItemBySerial(api, slot.smallBodSerial);
        }
      }
      destroyItemBySerial(api, deed.serial);
      ctx.state.sendSystemMessage(
        `Turned in: ${deed.bod.label}. ${reward.gold} gp${reward.special ? ` + ${reward.special.name}` : ''}.`,
      );
    },
  });

  return () => {
    api.commands.unregister('bodrewarder');
    api.commands.unregister('turninbod');
  };
}

export const _BOD_REWARDER_FOR_TEST = {
  bodPoints, rewardFor,
};
