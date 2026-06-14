// `[trophy` — mount a big fish on a wall plaque. ServUO
// `FishingTrophyDeed.cs`: a Tinker (or Carpenter ≥ 50) can preserve a
// big fish as a deco statue showing off the catch's weight. The fish
// item is consumed; a new immovable trophy item appears at the player's
// feet bearing the original weight in its label.

import { normalizeSkillValue } from '../../_rules.js';
import { isInPack } from '../../_inventory.js';
import { itemBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const TROPHY_ITEM = 0x14F0;       // a deed graphic (carries the name)
const REQUIRED_SKILL = 50;        // Tinkering or Carpentry, 50.0
const SKILL_TINKERING = 38;
const SKILL_CARPENTRY = 12;

function skillOf(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.commands || !api.targeting || !api.items) return () => {};

  api.commands.register({
    name: 'trophy',
    help: '[trophy — target a big fish to mount it as a trophy.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const tinker  = skillOf(mob, SKILL_TINKERING);
      const carp    = skillOf(mob, SKILL_CARPENTRY);
      if (tinker < REQUIRED_SKILL && carp < REQUIRED_SKILL) {
        ctx.state.sendSystemMessage('You need 50 Tinkering or Carpentry to mount a trophy.');
        return;
      }
      ctx.state.sendSystemMessage('Target the big fish to mount.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked) { ctx.state.sendSystemMessage('Cancelled.'); return; }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('That is not an item.'); return; }
        if (!item._trophyWeight) {
          ctx.state.sendSystemMessage('Only a big fish can be mounted as a trophy.');
          return;
        }
        if (item.parent !== mob.serial && !isInPack(api, item, mob)) {
          ctx.state.sendSystemMessage('The fish must be in your backpack.');
          return;
        }

        const weight = item._trophyWeight | 0;
        const fisher = mob.name ?? 'an angler';
        // Consume the fish, drop a trophy at the player's feet.
        destroyItemBySerial(api, item.serial);
        const trophy = createItem(api, api.world, {
          itemId: TROPHY_ITEM, hue: 0x481,
          x: mob.x, y: mob.y, z: mob.z, map: mob.map,
          name: `${fisher}'s prize fish (${weight} stone)`,
          movable: true,           // can be redeed-able later
        });
        trophy._fishTrophy = true;
        trophy._trophyWeight = weight;
        trophy._trophyAngler = fisher;
        ctx.state.sendSystemMessage(`You preserve the fish — ${weight} stone, a fine catch!`);
        // Notify nearby observers (worldItemSA fan-out happens via createItem).
        api.skillGain?.tryGain?.(mob, tinker >= REQUIRED_SKILL ? SKILL_TINKERING : SKILL_CARPENTRY, 50);
        void trophy;
      });
    },
  });

  return () => api.commands.unregister('trophy');
}
