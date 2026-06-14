// FAZA DM — Young player flag.
//
// ServUO `Misc/AccountHandler.cs` flags new accounts as `Young` for
// 40 hours of in-world play. Young players get:
//   - PK immunity (other players cannot damage them in non-faction PvP)
//   - "(Young)" suffix in name labels
//   - reduced loot drop (handled by corpse paragon path)
//
// We track `mob.youngPlayedMs` accumulated on every regen tick when
// the player is online. Once it crosses YOUNG_HOUR_LIMIT_MS the flag
// retires.

const YOUNG_HOUR_LIMIT_MS = 40 * 60 * 60 * 1000;

export function isYoung(mob) {
  if (!mob?.client) return false;
  if (mob.youngOptOut) return false;
  return (mob.youngPlayedMs | 0) < YOUNG_HOUR_LIMIT_MS;
}

/**
 * Tick the player's young-status counter. Called on the regen scheduler
 * (currently every 1 sec — see regen.js). Returns the new total.
 */
export function tickYoungTimer(mob, deltaMs) {
  if (!mob?.client) return 0;
  if (mob.youngOptOut) return mob.youngPlayedMs | 0;
  const before = mob.youngPlayedMs | 0;
  if (before >= YOUNG_HOUR_LIMIT_MS) return before;
  const after = before + (deltaMs | 0);
  mob.youngPlayedMs = after;
  if (before < YOUNG_HOUR_LIMIT_MS && after >= YOUNG_HOUR_LIMIT_MS) {
    mob.client.sendSystemMessage?.(
      'You are no longer considered a young player. The full perils of Britannia await you.',
    );
  }
  return after;
}

/**
 * Whether `attacker` is allowed to land damage on `victim` under the
 * young-player rules. Returns:
 *   true  → damage proceeds normally
 *   false → damage is blocked; caller should swallow it
 *
 * Rules:
 *   - Both parties are non-players → always allowed
 *   - Attacker is a young player → cannot hit other players
 *   - Victim is a young player → cannot be hit by other players
 */
export function canDamage(attacker, victim) {
  if (!attacker?.client && !victim?.client) return true;
  if (attacker?.client && victim?.client) {
    if (isYoung(attacker)) return false;
    if (isYoung(victim))   return false;
  }
  return true;
}

export function youngOptOut(mob) {
  if (!mob) return;
  mob.youngOptOut = true;
  mob.client?.sendSystemMessage?.('You have left the Young player programme.');
}

export const _YOUNG_CONST = Object.freeze({
  YOUNG_HOUR_LIMIT_MS,
});
