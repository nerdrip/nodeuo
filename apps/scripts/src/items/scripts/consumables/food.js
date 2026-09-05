// Food — generic edible item. Restores +10 stamina instantly + applies
// a 'sated' status effect that doubles HP regen for 60 seconds.
// PHASE DS: ServUO `Food.cs` increments `Player.Hunger` and the regen
// scheduler reads it; we model the same idea via a status effect that
// regen.js's hasEffect path picks up.

import { consumeOne } from '../_shared/consume.js';

const TOOTH_ACHE_INTERVAL_MS = 30_000;
const TOOTH_ACHE_MESSAGES = [
  'ARRGH! My tooth hurts sooo much!',
  "You just can't find a good Britannian dentist these days...",
  'My teeth!',
  'MAKE IT STOP!',
  'AAAH! It feels like someone kicked me in the teeth!',
];

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function applyToothAche(api, user, item) {
  if (!item?.givesToothAche) return;
  const acidity = Math.max(0, item.toothAcheAcidity ?? 32);
  if (acidity <= 0) return;
  const total = Math.max(0, user._toothAcheAcidity | 0) + acidity;
  const durationMs = Math.max(TOOTH_ACHE_INTERVAL_MS, total * TOOTH_ACHE_INTERVAL_MS);
  api.statusEffects?.apply?.(user, {
    name: 'tooth-ache',
    durationMs,
    tickIntervalMs: TOOTH_ACHE_INTERVAL_MS,
    data: { servuoClass: 'ToothAcheTimer' },
    tick(mob) {
      const next = Math.max(0, (mob._toothAcheAcidity | 0) - 1);
      mob._toothAcheAcidity = next;
      mob._toothAcheNextAt = Date.now() + TOOTH_ACHE_INTERVAL_MS;
      if (next === 60) {
        mob.client?.sendSystemMessage?.('The extreme pain in your teeth subsides.');
        return;
      }
      if (next > 60) mob.client?.sendSystemMessage?.(randomChoice(TOOTH_ACHE_MESSAGES));
      if (next <= 0) {
        delete mob._toothAcheAcidity;
        delete mob._toothAcheNextAt;
      }
    },
    onRemove(mob) {
      if ((mob._toothAcheAcidity | 0) <= 1) {
        delete mob._toothAcheAcidity;
        delete mob._toothAcheNextAt;
      }
    },
  });
  user._toothAcheAcidity = total;
  user._toothAcheNextAt = Date.now() + TOOTH_ACHE_INTERVAL_MS;
}

export default function buildFoodScript(api) {
  return {
    name: 'food',
    onCreate(_world, item) {
      if (item.givesToothAche) {
        item.holidaySweet ??= true;
        item.servuoClasses ??= [item.servuoClass, 'BaseSweet', 'ToothAcheTimer'].filter(Boolean);
      }
    },
    onUse(world, item, user) {
      if (!user) return false;
      if (Array.isArray(item.gingerBreadMessages) && item.gingerBreadMessages.length > 0) {
        const message = randomChoice(item.gingerBreadMessages);
        if (message) {
          user.client?.sendSystemMessage?.(message);
          return false;
        }
      }
      applyToothAche(api, user, item);
      user.stam = Math.min(user.stamMax ?? 50, (user.stam ?? 0) + 10);
      user.client?.sendSystemMessage?.(item.givesToothAche
        ? 'You feel as if you could eat as much as you wanted!'
        : 'You eat the food.');
      // PHASE DS: over-time regen tick. Stack-friendly — eating again
      // refreshes the duration without compounding the multiplier.
      api.statusEffects?.apply?.(user, { name: 'sated', durationMs: 60_000 });
      consumeOne(api, world, item, user);
      return true;
    },
  };
}
