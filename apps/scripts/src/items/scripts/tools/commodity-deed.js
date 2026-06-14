// Commodity Deed — ServUO `Items/Consumables/CommodityDeed.cs`.
//
// Compacts a stack of bulk commodities (ingots, boards, hides, regs)
// into a single deed item — convenient for moving 50 000 ingots across
// world facets or between bank vendors. Reversible: double-clicking a
// filled deed reissues the stack into the user's pack.
//
// Storage on the item:
//   item.commodity = { resource: 'iron-ingot', amount: 12345 }
//
// Empty deed = `commodity` missing. Double-click empty -> target a
// stackable; fill it. Double-click filled -> dump stack back into pack.

import { isInPack } from '../../../_inventory.js';
import { destroyItemBySerial } from '../../../_items.js';
import { itemBySerial } from '../../../_entities.js';

const STACKABLE_RESOURCES = new Set([
  'iron-ingot', 'dull-copper-ingot', 'shadow-iron-ingot', 'copper-ingot',
  'bronze-ingot', 'gold-ingot', 'agapite-ingot', 'verite-ingot', 'valorite-ingot',
  'oak-board', 'ash-board', 'yew-board', 'heartwood-board', 'bloodwood-board',
  'spined-leather', 'horned-leather', 'barbed-leather', 'cured-hide',
  'iron-ore', 'sandstone',
  'black-pearl', 'blood-moss', 'garlic', 'ginseng',
  'mandrake-root', 'nightshade', 'spider-silk', 'sulfurous-ash',
  'bat-wing', 'daemon-blood', 'grave-dust', 'nox-crystal', 'pig-iron',
]);

const RESOURCE_ITEMS = {
  'iron-ingot': { itemId: 0x1BF2, name: 'iron ingot' },
  'dull-copper-ingot': { itemId: 0x1BF2, hue: 0x0973, name: 'dull copper ingot' },
  'shadow-iron-ingot': { itemId: 0x1BF2, hue: 0x0966, name: 'shadow iron ingot' },
  'copper-ingot': { itemId: 0x1BF2, hue: 0x096D, name: 'copper ingot' },
  'bronze-ingot': { itemId: 0x1BF2, hue: 0x0972, name: 'bronze ingot' },
  'gold-ingot': { itemId: 0x1BF2, hue: 0x08A5, name: 'gold ingot' },
  'agapite-ingot': { itemId: 0x1BF2, hue: 0x0979, name: 'agapite ingot' },
  'verite-ingot': { itemId: 0x1BF2, hue: 0x089F, name: 'verite ingot' },
  'valorite-ingot': { itemId: 0x1BF2, hue: 0x08AB, name: 'valorite ingot' },
  'oak-board': { itemId: 0x1BD7, name: 'oak board' },
  'ash-board': { itemId: 0x1BD7, hue: 0x04A7, name: 'ash board' },
  'yew-board': { itemId: 0x1BD7, hue: 0x04A8, name: 'yew board' },
  'heartwood-board': { itemId: 0x1BD7, hue: 0x04AA, name: 'heartwood board' },
  'bloodwood-board': { itemId: 0x1BD7, hue: 0x04AB, name: 'bloodwood board' },
  'spined-leather': { itemId: 0x1078, hue: 0x08AC, name: 'spined leather' },
  'horned-leather': { itemId: 0x1078, hue: 0x0845, name: 'horned leather' },
  'barbed-leather': { itemId: 0x1078, hue: 0x0851, name: 'barbed leather' },
  'cured-hide': { itemId: 0x1079, name: 'cured hide' },
  'iron-ore': { itemId: 0x19B7, name: 'iron ore' },
  sandstone: { itemId: 0x1779, name: 'sandstone' },
  'black-pearl': { itemId: 0x0F7A, name: 'black pearl' },
  'blood-moss': { itemId: 0x0F7B, name: 'blood moss' },
  garlic: { itemId: 0x0F84, name: 'garlic' },
  ginseng: { itemId: 0x0F85, name: 'ginseng' },
  'mandrake-root': { itemId: 0x0F86, name: 'mandrake root' },
  nightshade: { itemId: 0x0F88, name: 'nightshade' },
  'spider-silk': { itemId: 0x0F8C, name: 'spider silk' },
  'sulfurous-ash': { itemId: 0x0F8D, name: 'sulfurous ash' },
  'bat-wing': { itemId: 0x0F78, name: 'bat wing' },
  'daemon-blood': { itemId: 0x0F7D, name: 'daemon blood' },
  'grave-dust': { itemId: 0x0F8F, name: 'grave dust' },
  'nox-crystal': { itemId: 0x0F8E, name: 'nox crystal' },
  'pig-iron': { itemId: 0x0F8A, name: 'pig iron' },
};

export default function buildCommodityDeed(api) {
  return {
    name: 'commodity-deed',
    onUse(world, item, user) {
      const runtimeApi = api?.world ? api : { ...api, world };
      if (!user?.client) return true;
      if (item.commodity) {
        // Filled — reissue. Drop one stack into the user's pack.
        const { resource, amount } = item.commodity;
        const def = RESOURCE_ITEMS[resource];
        if (!def) {
          user.client.sendSystemMessage?.(`Unknown commodity resource: ${resource}.`);
          return true;
        }
        const stack = api.game?.mobile?.giveItem?.(user, {
          itemId: def.itemId,
          hue: def.hue ?? 0,
          name: def.name ?? resource.replace(/-/g, ' '),
          amount: amount | 0,
        }, { randomGrid: true });
        if (!stack) { user.client.sendSystemMessage?.('You have no backpack.'); return true; }
        stack.kind = resource;
        user.client.sendSystemMessage?.(`The deed dissolves; ${amount} ${resource} appear in your pack.`);
        try { destroyItemBySerial(api, item.serial); } catch { /* advisory */ }
        return true;
      }
      // Empty — target a commodity stack.
      if (!api.targeting?.request) return true;
      user.client.sendSystemMessage?.('Target the commodity stack to compact.');
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) return;
        const stack = itemBySerial({ world }, picked.serial >>> 0);
        if (!stack) { user.client.sendSystemMessage?.('That is not a valid commodity.'); return; }
        if (!isInPack(runtimeApi, stack, user)) {
          user.client.sendSystemMessage?.('The stack must be in your pack.');
          return;
        }
        if (!STACKABLE_RESOURCES.has(stack.kind)) {
          user.client.sendSystemMessage?.('That cannot be compacted into a deed.');
          return;
        }
        const amount = stack.amount | 0;
        if (amount < 1) {
          user.client.sendSystemMessage?.('Empty stack.');
          return;
        }
        item.commodity = { resource: stack.kind, amount };
        item.label = `Commodity deed: ${amount} ${stack.kind.replace(/-/g, ' ')}`;
        try { destroyItemBySerial(api, stack.serial); } catch { /* advisory */ }
        try { api.items?.invalidateProps?.(item.serial); } catch { /* advisory */ }
        user.client.sendSystemMessage?.(`Compacted ${amount} ${stack.kind} into the deed.`);
      });
      return true;
    },
  };
}
