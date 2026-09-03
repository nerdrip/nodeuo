// Drink (wine / water / milk / ale) — beverage system with alcohol
// fatigue. ServUO `Items/Skill Items/Cooking/BaseBeverage.cs`:
//   - Water/milk: hydrates only.
//   - Ale/wine/liquor: increases `_alcoholFatigue` 0..100. Above 60
//     the player walks crooked + has -10% hit chance; above 90 they
//     pass out (3s paralysis + screen jitter). `_alcoholFatigue`
//     decays by 1/min via the status-effects framework. Sober up
//     instantly via Cure spell or a Wand of Sobriety.
//
// We detect alcohol vs. non-alcohol by item name (ServUO equivalent:
// `BaseBeverage.Content == BeverageType.Ale | LiquorDrink`).

import { consumeOne } from '../_shared/consume.js';

const ALCOHOL_KEYWORDS = ['ale', 'wine', 'liquor', 'rum', 'mead', 'cider', 'stout', 'whiskey'];
const FATIGUE_DECAY_PER_MIN = 1;
const FATIGUE_PER_SIP = 12;
const TIPSY_THRESHOLD = 60;
const PASS_OUT_THRESHOLD = 90;

function isAlcoholic(item) {
  const n = String(item.name ?? '').toLowerCase();
  return ALCOHOL_KEYWORDS.some((k) => n.includes(k));
}

export default function buildDrinkScript(api) {
  const scheduleDecay = (user) => {
    if (api.statusEffects?.apply) {
      api.statusEffects.apply(user, {
        name: 'alcohol-fatigue',
        durationMs: 101 * 60_000,
        tickIntervalMs: 60_000,
        tick(mob) {
          mob._alcoholFatigue = Math.max(0, (mob._alcoholFatigue | 0) - FATIGUE_DECAY_PER_MIN);
          if ((mob._alcoholFatigue | 0) === 0) api.statusEffects?.remove?.(mob, 'alcohol-fatigue');
        },
      });
      return;
    }
    // Lightweight test/embedding fallback when the shared effect sweeper is
    // not installed. Production uses one world timer, not one timer/player.
    if (user._alcoholDecayHandle) return;
    user._alcoholDecayHandle = setInterval(() => {
      user._alcoholFatigue = Math.max(0, (user._alcoholFatigue | 0) - FATIGUE_DECAY_PER_MIN);
      if ((user._alcoholFatigue | 0) === 0 && user._alcoholDecayHandle) {
        clearInterval(user._alcoholDecayHandle);
        user._alcoholDecayHandle = null;
      }
    }, 60_000);
    user._alcoholDecayHandle?.unref?.();
  };
  return {
    name: 'drink',
    onUse(world, item, user) {
      if (!user) return false;
      const state = user.client;
      if (!isAlcoholic(item)) {
        state?.sendSystemMessage?.('You drink it down. Refreshing.');
        consumeOne(api, world, item, user);
        return true;
      }
      // Alcoholic — bump fatigue.
      user._alcoholFatigue = Math.min(100, (user._alcoholFatigue ?? 0) + FATIGUE_PER_SIP);
      scheduleDecay(user);
      consumeOne(api, world, item, user);
      const lvl = user._alcoholFatigue;
      if (lvl >= PASS_OUT_THRESHOLD) {
        state?.sendSystemMessage?.('The world spins — you collapse, blackout drunk.');
        // 3s paralyze via status-effects framework.
        try { api.statusEffects?.apply?.(user, { name: 'paralyze', durationMs: 3000 }); }
        catch { /* effects optional */ }
        // Sober up a touch on collapse.
        user._alcoholFatigue = Math.max(0, lvl - 30);
      } else if (lvl >= TIPSY_THRESHOLD) {
        state?.sendSystemMessage?.('You feel tipsy — the room sways a little.');
      } else {
        state?.sendSystemMessage?.('You drink it down. A pleasant warmth spreads.');
      }
      return true;
    },
  };
}

/** Sober up — invoked by the Cure spell / Wand of Sobriety / time. */
export function soberUp(user) {
  if (!user) return false;
  user._alcoholFatigue = 0;
  if (user._alcoholDecayHandle) {
    clearInterval(user._alcoholDecayHandle);
    user._alcoholDecayHandle = null;
  }
  return true;
}

/** Read current intoxication tier — used by combat formulas (hit
 *  chance malus above TIPSY_THRESHOLD). */
export function intoxicationTier(user) {
  const lvl = user?._alcoholFatigue | 0;
  if (lvl >= PASS_OUT_THRESHOLD) return 'blackout';
  if (lvl >= TIPSY_THRESHOLD)    return 'tipsy';
  if (lvl >= 30)                  return 'buzzed';
  return 'sober';
}
