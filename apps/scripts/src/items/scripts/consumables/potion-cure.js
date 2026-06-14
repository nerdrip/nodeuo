// Cure potion — clears the `poison` status effect.

import { consumeOne } from '../_shared/consume.js';

export const CureLevelInfo = Object.freeze({
  lesser:  [
    { level: 0, chance: 1.00 }, { level: 1, chance: 0.35 },
    { level: 2, chance: 0.15 }, { level: 3, chance: 0.10 }, { level: 4, chance: 0.05 },
  ],
  normal:  [
    { level: 0, chance: 1.00 }, { level: 1, chance: 0.95 },
    { level: 2, chance: 0.45 }, { level: 3, chance: 0.25 }, { level: 4, chance: 0.15 },
  ],
  greater: [
    { level: 0, chance: 1.00 }, { level: 1, chance: 1.00 },
    { level: 2, chance: 0.75 }, { level: 3, chance: 0.45 }, { level: 4, chance: 0.25 },
  ],
  total: [
    { level: 0, chance: 1.00 }, { level: 1, chance: 1.00 },
    { level: 2, chance: 1.00 }, { level: 3, chance: 1.00 }, { level: 4, chance: 1.00 },
  ],
});

function chanceFor(item, level) {
  const info = Array.isArray(item?.cureLevelInfo)
    ? item.cureLevelInfo
    : CureLevelInfo[item?.cureTier ?? 'normal'];
  const rec = info?.find?.((entry) => (entry.level | 0) === (level | 0));
  return rec?.chance ?? 0;
}

export default function buildPotionCureScript(api) {
  return {
    name: 'potion-cure',
    onCreate(_world, item) {
      item.cureTier ??= 'normal';
      item.cureLevelInfo ??= CureLevelInfo[item.cureTier] ?? CureLevelInfo.normal;
      item.servuoClasses ??= ['BaseCurePotion', 'CureLevelInfo'];
    },
    onUse(world, item, user) {
      if (!user) return false;
      const now = Date.now();
      if ((user._lastPotionAt ?? 0) > now - 10_000) {
        const wait = Math.ceil((10_000 - (now - (user._lastPotionAt ?? 0))) / 1000);
        user.client?.sendSystemMessage?.(`You must wait ${wait}s before drinking another potion.`);
        return false;
      }
      user._lastPotionAt = now;
      if (!user.poisoned && !api.statusEffects?.has?.(user, 'poison')) {
        user.client?.sendSystemMessage?.('You are not poisoned.');
        user._lastPotionAt = 0;
        return false;
      }
      const level = Math.max(0, Math.min(4, user.poisonLevel | 0));
      const chance = chanceFor(item, level);
      if (Math.random() < chance) {
        api.statusEffects?.remove?.(user, 'poison');
        user.poisoned = false;
        user.poisonLevel = 0;
        user._poisonExpiresAt = 0;
        user.client?.sendSystemMessage?.('You feel cured of poison!');
      } else {
        user.client?.sendSystemMessage?.('That potion was not strong enough to cure your ailment!');
      }
      consumeOne(api, world, item, user);
      return true;
    },
  };
}
