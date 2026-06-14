// Faction Stronghold Capture — territorial PvP loop layered on top of
// the existing `faction-strongholds.js` registry.
//
// ServUO `Engines/Factions/Town.cs` ships a town-buy + commander
// system; we add the *capture-the-flag*-style mechanic that's been
// requested but missing: each stronghold has a Capture Flag, and an
// opposing faction member can spend 30 s standing within 4 tiles of
// the flag to flip control to their faction. While capture is in
// progress, every other-faction member entering the radius resets
// the timer back to 0; the contesting member must be alone (or
// fellow-faction-only) for the full 30 s.
//
// On a successful flip:
//   - the stronghold's `controllingFaction` swaps to the attacker
//   - the holder loses 100 faction silver pool (deducted from
//     `_factionSilver[faction]`); the attacker gains 100
//   - shard-wide announce via shardEvents 'faction-capture'
//   - 1-hour grace period before the same flag can be re-flipped
//
// State is module-local + serializable for persistence.

import { listStrongholds } from './faction-strongholds.js';

const CAPTURE_RADIUS = 4;
const CAPTURE_DURATION_MS = 30_000;
const POST_CAPTURE_GRACE_MS = 60 * 60 * 1000;
const SILVER_REWARD = 100;

/** Per-stronghold capture state. */
const _state = new Map();           // factionKey → { controlling, capturing, capturingAttacker, captureStartedAt, lastCaptureAt }

/** Faction silver pool — readable by any system that needs to query/
 *  mutate the territorial economy (e.g. vendor sales tax). */
const _silver = new Map();          // factionKey → number

function ensureState(factionKey) {
  if (!_state.has(factionKey)) {
    _state.set(factionKey, {
      controlling: factionKey,        // home faction starts as controller
      capturing: null,
      capturingAttacker: 0,
      captureStartedAt: 0,
      lastCaptureAt: 0,
    });
  }
  return _state.get(factionKey);
}

/** Look at all 4 strongholds and update their capture state given the
 *  current world. Call from a 1s tick. Returns the array of capture
 *  events (transitions) since the last tick. */
export function tickCapture(world, now = Date.now()) {
  const events = [];
  for (const sh of listStrongholds()) {
    const st = ensureState(sh.faction);
    // Grace period — flag can't be captured again right after a flip.
    if (now - st.lastCaptureAt < POST_CAPTURE_GRACE_MS) continue;

    // Walk nearby mobiles. We tally the "attackers" — players of a
    // faction OTHER than the current controller — and check for any
    // defender presence.
    let attackerFaction = null;
    let attackerSerial = 0;
    let defenderPresent = false;
    let attackerContested = false;

    for (const m of world.mobiles?.values?.() ?? []) {
      if (!m.client) continue;
      if (m.map !== sh.map) continue;
      const dx = m.x - sh.x;
      const dy = m.y - sh.y;
      if (dx * dx + dy * dy > CAPTURE_RADIUS * CAPTURE_RADIUS) continue;
      if (!m.faction) continue;
      if (m.faction === st.controlling) {
        defenderPresent = true;
        continue;
      }
      // Other-faction member — qualifies as attacker.
      if (attackerFaction == null) {
        attackerFaction = m.faction;
        attackerSerial = m.serial;
      } else if (m.faction !== attackerFaction) {
        // Two different attacker factions both contesting — no one
        // makes progress.
        attackerContested = true;
      }
    }

    // Reset on defender presence or attacker contention.
    if (defenderPresent || attackerContested || attackerFaction == null) {
      if (st.capturing) {
        st.capturing = null;
        st.capturingAttacker = 0;
        st.captureStartedAt = 0;
        events.push({ kind: 'capture-reset', stronghold: sh.faction, name: sh.name });
      }
      continue;
    }

    // Same attacker as last tick? continue progress. Else reset timer.
    if (st.capturing !== attackerFaction) {
      st.capturing = attackerFaction;
      st.capturingAttacker = attackerSerial;
      st.captureStartedAt = now;
      events.push({ kind: 'capture-start', stronghold: sh.faction, attacker: attackerFaction, name: sh.name });
      continue;
    }

    // Already capturing — check if duration elapsed.
    if (now - st.captureStartedAt >= CAPTURE_DURATION_MS) {
      const previous = st.controlling;
      st.controlling = attackerFaction;
      st.capturing = null;
      st.capturingAttacker = 0;
      st.captureStartedAt = 0;
      st.lastCaptureAt = now;
      // Silver swing.
      _silver.set(previous, Math.max(0, (_silver.get(previous) | 0) - SILVER_REWARD));
      _silver.set(attackerFaction, (_silver.get(attackerFaction) | 0) + SILVER_REWARD);
      events.push({
        kind: 'capture-complete',
        stronghold: sh.faction, previous, newHolder: attackerFaction,
        name: sh.name, attackerSerial,
      });
    }
  }
  return events;
}

export function statusOf(factionKey, now = Date.now()) {
  const st = ensureState(factionKey);
  let captureProgress = 0;
  if (st.capturing && st.captureStartedAt > 0) {
    captureProgress = Math.min(1, (now - st.captureStartedAt) / CAPTURE_DURATION_MS);
  }
  const graceMs = Math.max(0, st.lastCaptureAt + POST_CAPTURE_GRACE_MS - now);
  return {
    home: factionKey,
    controlling: st.controlling,
    capturing: st.capturing,
    captureProgress,
    graceMs,
    silver: _silver.get(factionKey) | 0,
  };
}

/** Force-set the controller (admin tool / persistence restore). */
export function setController(factionKey, holder) {
  const st = ensureState(factionKey);
  st.controlling = holder;
  st.capturing = null;
  st.captureStartedAt = 0;
}

export function silverOf(factionKey) { return _silver.get(factionKey) | 0; }
export function adjustSilver(factionKey, delta) {
  _silver.set(factionKey, Math.max(0, (_silver.get(factionKey) | 0) + (delta | 0)));
  return _silver.get(factionKey);
}

/** Snapshot for persistence. */
export function serialize() {
  return {
    state: Object.fromEntries(_state),
    silver: Object.fromEntries(_silver),
  };
}

export function deserialize(snap) {
  if (!snap) return;
  _state.clear();
  for (const [k, v] of Object.entries(snap.state ?? {})) {
    _state.set(k, { ...v });
  }
  _silver.clear();
  for (const [k, v] of Object.entries(snap.silver ?? {})) {
    _silver.set(k, v | 0);
  }
}
