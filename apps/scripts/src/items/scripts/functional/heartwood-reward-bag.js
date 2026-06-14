import { destroyItemBySerial } from '../../../_items.js';
// Heartwood Reward Bag — onUse pops the bag and stamps its randomly-
// rolled special attribute (`_heartwoodAttr`) onto the player's
// `_pendingHeartwoodAttr` slot. The next exceptional carpentry /
// fletching / bowyer craft consumes that slot and writes the matching
// magic property onto the result (Brittle / Antique / Etched / Resonant
// / Auspicious — ServUO `HeartwoodRewardBag.cs`).
//
// Crafting hook is deliberately minimal: we just stamp the attr on the
// player's pending-slot. The craft pipeline (`crafting/index.js`) reads
// `_pendingHeartwoodAttr` on success and clears it after applying.

export default function buildHeartwoodRewardBag(api) {
  return {
    name: 'heartwood-reward-bag',
    onUse(_world, item, user) {
      if (!user?.client) return;
      const attr = item._heartwoodAttr ?? 'Resonant';
      // Stamp on the user — next successful craft picks it up.
      user._pendingHeartwoodAttr = attr;
      user._pendingHeartwoodUntil = Date.now() + 60 * 60_000;     // 1h window
      user.client.sendSystemMessage?.(
        `You open the heartwood bag. Your next exceptional craft will be ${attr}.`,
      );
      // Consume the bag.
      try { destroyItemBySerial(api, item.serial); }
      catch { /* gone */ }
    },
  };
}
