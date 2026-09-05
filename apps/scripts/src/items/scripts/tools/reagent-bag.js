// PHASE FA — Reagent Bag of Holding.
//
// ServUO `Items/Containers/PackOfHolding.cs` (Mondain's Legacy reward):
// auto-stocks reagent stacks from the player's main pack into a sub-bag,
// auto-fills missing reagents during cast. We expose the bag as a
// container item with a flag `reagentBag = true`. Cast helpers
// (PHASE DW findReagent) already walk the parent chain, so reagents
// inside this bag count for spell consumption.
//
// The lifecycle script's onUse simply lists the bag's reagent contents.

import { childrenOf } from '../../../_inventory.js';

export default function buildReagentBagScript(api) {
  return {
    name: 'reagent-bag',
    onUse(world, item, user) {
      const counts = new Map();
      for (const it of childrenOf(api, item)) {
        // Coarse "is reagent" filter — bag accepts anything with a
        // template name starting with "reagent-".
        const tpl = it.template ?? '';
        if (typeof tpl !== 'string' || !tpl.startsWith('reagent-')) continue;
        counts.set(tpl, (counts.get(tpl) ?? 0) + (it.amount | 0));
      }
      if (counts.size === 0) {
        user?.client?.sendSystemMessage?.('The reagent bag is empty.');
        return true;
      }
      user?.client?.sendSystemMessage?.('Reagent bag contents:');
      for (const [tpl, n] of counts) {
        user?.client?.sendSystemMessage?.(`  ${tpl.replace(/^reagent-/, '')}: ${n}`);
      }
      return true;
    },
  };
}
