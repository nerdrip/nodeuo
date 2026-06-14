// Aggression / Heat-of-Battle tracker.
//
// ServUO `Misc/Aggression.cs` keeps a per-mob list of `AggressorInfo`
// entries that decay after 2 minutes from the last hostile interaction.
// While the list is non-empty the mob is considered "in combat":
//   • PvP loot rules apply (one tag = full loot rights)
//   • Cannot logout instantly (server holds the connection 30 s)
//   • Cannot recall / sacred-journey / gate-travel
//   • Pets can't be stabled with the trainer
//   • The client shows the "Heat of Battle" buff icon (0x426)
//
// This module is the canonical setter; `combat.damage` calls `stamp`
// on the attacker+victim pair, and gameplay gates above check
// `isInCombat(mob)`. The decay is purely lazy — fields are stamps,
// no per-tick sweep needed.

const COMBAT_DURATION_MS = 120_000;        // ServUO heat-of-battle = 2 min

const BUFF_ICON_HEAT_OF_BATTLE = 0x426;     // ServUO BuffIcon.HeatOfBattleStatus

/** Stamp both the attacker and the victim with a fresh combat window.
 *  Safe to call repeatedly — refreshing the expiry is the desired
 *  behaviour (each successive swing extends the window).
 *
 *  Also records the aggressor-pair into a lightweight `_aggressors`
 *  Map on the victim, keyed by attacker serial → last-damage epoch ms.
 *  Mirrors ServUO `Mobile.Aggressors` at MVP scope: lets readers ask
 *  "who hit me, most recently" — used by `aggression.recentAggressors`
 *  for re-target priority and "who can loot my corpse" rules. The
 *  Map is bounded (max 8 entries; oldest expire on next stamp) so a
 *  long-living boss can't accumulate megabytes of state.
 *
 *  @param {*} world
 *  @param {*} attacker
 *  @param {*} victim
 */
export function stamp(world, attacker, victim) {
  const now = Date.now();
  const expires = now + COMBAT_DURATION_MS;
  let added = 0;
  for (const m of [attacker, victim]) {
    if (!m) continue;
    const wasInCombat = (m._combatUntil ?? 0) > now;
    m._combatUntil = expires;
    if (!wasInCombat) {
      added++;
      // Send the buff icon to the player so their buff bar shows the
      // "In Combat" indicator immediately. Mobs without a client (NPCs,
      // pets) just track the stamp internally.
      _emitBuffOn(world, m, expires);
    }
  }
  // Record the aggressor pair on the victim. Skip self-damage (DoT
  // proc, drowning) so a player isn't their own "top aggressor".
  if (attacker && victim && attacker !== victim) {
    const list = victim._aggressors instanceof Map
      ? victim._aggressors
      : (victim._aggressors = new Map());
    list.set(attacker.serial >>> 0, now);
    // Prune entries past the 2-min decay window AND keep at most 8.
    // Two passes: drop stale, then trim to capacity if still too big.
    if (list.size > 1) {
      for (const [k, t] of list) {
        if (now - t > COMBAT_DURATION_MS) list.delete(k);
      }
      while (list.size > 8) {
        // Drop the oldest by walking the insertion-ordered iterator.
        const oldest = list.keys().next().value;
        if (oldest == null) break;
        list.delete(oldest);
      }
    }
  }
  return added;
}

/** Read recent aggressors of `mob` sorted newest → oldest. Filters out
 *  entries past the 2-min heat-of-battle window. Returns an array of
 *  `{ serial, at }` entries — callers can join against `world.mobiles`
 *  to resolve to live targets. */
export function recentAggressors(mob, now = Date.now()) {
  const list = mob?._aggressors;
  if (!(list instanceof Map) || list.size === 0) return [];
  const cutoff = now - COMBAT_DURATION_MS;
  const out = [];
  for (const [serial, at] of list) {
    if (at >= cutoff) out.push({ serial: serial >>> 0, at });
  }
  out.sort((a, b) => b.at - a.at);
  return out;
}

/** Returns true if the mob is still inside their combat window. */
export function isInCombat(mob, now = Date.now()) {
  return (mob?._combatUntil ?? 0) > now;
}

/** Clear the combat window early (e.g. mob deleted / instance reset). */
export function clear(world, mob) {
  if (!mob) return;
  if ((mob._combatUntil ?? 0) > 0) {
    mob._combatUntil = 0;
    _emitBuffOff(world, mob);
  }
}

/** Sweep — call from main loop occasionally to send the "buff removed"
 *  packet when the 2-min window lapses. Lazy: only mobs that *had* a
 *  pending combat stamp are checked.
 *  Returns the count of mobs whose buff was cleared.
 */
export function sweepExpired(world, now = Date.now()) {
  if (!world?.mobiles) return 0;
  let cleared = 0;
  for (const m of world.mobiles.values()) {
    if (!m._combatUntil) continue;
    if (m._combatUntil > now) continue;
    m._combatUntil = 0;
    _emitBuffOff(world, m);
    cleared++;
  }
  return cleared;
}

// ---- internal -----------------------------------------------------------

function _emitBuffOn(world, mob, expiresAt) {
  if (!mob?.client) return;
  const protocol = world?._protocol;
  if (!protocol?.buffDebuff) return;
  try {
    const remaining = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    mob.client.send(protocol.buffDebuff({
      serial: mob.serial >>> 0,
      type: BUFF_ICON_HEAT_OF_BATTLE,
      action: 1,                            // add
      timeLeftSec: remaining,
      titleCliloc: 1153807,                 // "Heat of Battle"
      bodyCliloc:  1153808,
      argCliloc:   '',
    }));
  } catch { /* advisory */ }
}

function _emitBuffOff(world, mob) {
  if (!mob?.client) return;
  const protocol = world?._protocol;
  if (!protocol?.buffDebuff) return;
  try {
    mob.client.send(protocol.buffDebuff({
      serial: mob.serial >>> 0,
      type: BUFF_ICON_HEAT_OF_BATTLE,
      action: 0,                            // remove
    }));
  } catch { /* advisory */ }
}
