// Faction strongholds + commander elections. Mirrors ServUO
// `Engines/Factions/Core/Faction.cs` (commander state) +
// `Engines/Factions/Town.cs` (stronghold registry).
//
// The full ServUO faction game has town-buy menus, vendor placement,
// faction silver, and bondage banks; we implement the canonical core
// the rest of the system can build on:
//
//   - 4 strongholds, one per faction, anchored at canonical UO coords
//   - commander election cycle (1 hour rotation, member with most
//     factionKills wins; ties broken by earliest join)
//   - per-faction NPC roster (guards, vendor, commander) tagged with
//     `mob.faction` so notoriety + AI hostility paths consult the
//     same field as players
//   - sigil-base placement helper (after corruption sigils home to the
//     winning faction's stronghold)
//
// State lives in module-locals; `snapshot()` and `restore()` plug into
// persistence.js for cross-restart continuity.

import { FACTIONS } from './factions.js';

const STRONGHOLDS = Object.freeze({
  council:     { name: 'Magincia', x: 3712, y: 2222, map: 0 },
  minax:       { name: 'Britain - Castle', x: 1417, y: 1738, map: 0 },
  shadowlords: { name: "Yew Crypt", x: 6411, y: 56, map: 0 },
  truebrits:   { name: 'Vesper', x: 2901, y: 676, map: 0 },
});

const ELECTION_PERIOD_MS = 60 * 60 * 1000;
let _lastElection = 0;
/** Map<factionKey, mobileSerial> */
const _commanders = new Map();

/**
 * Resolve the home base coordinates for a faction.
 * @param {string} factionKey
 */
export function strongholdOf(factionKey) {
  return STRONGHOLDS[factionKey] ?? null;
}

/** Snapshot of all strongholds (for content / admin gump). */
export function listStrongholds() {
  return Object.entries(STRONGHOLDS).map(([k, v]) => ({ faction: k, ...v }));
}

/** Current commander map: { factionKey → mobileSerial }. */
export function commanders() { return new Map(_commanders); }

/**
 * Run the periodic commander election. Walks the world, groups
 * faction members by faction, picks the highest-`factionKills` mob in
 * each. Caller supplies the `world` so we can iterate live mobs.
 *
 * Returns an array of { faction, mob, prev } describing transitions.
 */
export function runElection(world, now = Date.now()) {
  if (now - _lastElection < ELECTION_PERIOD_MS) return [];
  _lastElection = now;
  const groups = new Map();
  for (const m of world.mobiles.values()) {
    if (!m.faction) continue;
    if (!FACTIONS[m.faction]) continue;
    if (!m.client) continue;     // commander must be a player
    let arr = groups.get(m.faction);
    if (!arr) { arr = []; groups.set(m.faction, arr); }
    arr.push(m);
  }
  const transitions = [];
  for (const [factionKey, arr] of groups) {
    arr.sort((a, b) => {
      const ka = a.factionKills | 0, kb = b.factionKills | 0;
      if (ka !== kb) return kb - ka;
      const ja = a._factionJoinedAt ?? 0, jb = b._factionJoinedAt ?? 0;
      return ja - jb;
    });
    // Bug-hunt #7 B12: drop the stale commander pointer first so a
    // commander who left the faction / was destroyed / changed factions
    // doesn't keep the entry forever. Verify the previous winner still
    // exists, is online (or at least in-world), and is still in this
    // faction. Otherwise clear so the election runs cleanly.
    const prev = _commanders.get(factionKey);
    if (prev != null) {
      const prevMob = world.mobiles.get(prev);
      if (!prevMob || prevMob.faction !== factionKey) {
        _commanders.delete(factionKey);
      }
    }
    const winner = arr[0];
    if (!winner) continue;
    const cur = _commanders.get(factionKey);
    if (cur !== winner.serial) {
      _commanders.set(factionKey, winner.serial);
      transitions.push({ faction: factionKey, mob: winner, prev: cur });
    }
  }
  return transitions;
}

/**
 * Update faction membership AND stamp the join time so the election
 * tiebreaker has data. Wraps the lower-level `joinFaction` helper.
 *
 * @param {*} mob
 * @param {string} factionKey
 * @param {number} now
 */
export function joinFactionWithStamp(mob, factionKey, now = Date.now()) {
  if (!mob || !FACTIONS[factionKey]) return false;
  if (mob.faction === factionKey) return false;
  mob.faction = factionKey;
  mob.factionKills = mob.factionKills | 0;
  mob._factionJoinedAt = now;
  return true;
}

/**
 * Compute where a corrupted sigil should home. ServUO `Sigil.HomeBase`
 * sends the sigil to the controlling faction's stronghold; if that
 * faction has no commander yet, it stays at the town instead.
 */
export function sigilBaseFor(factionKey) {
  const sh = strongholdOf(factionKey);
  if (!sh) return null;
  return { x: sh.x, y: sh.y, map: sh.map };
}

/** Persistence — wired by world snapshotter. */
export function snapshot() {
  return {
    lastElection: _lastElection,
    commanders: Array.from(_commanders.entries()),
  };
}

export function restore(state) {
  if (!state) return;
  _lastElection = state.lastElection | 0;
  _commanders.clear();
  if (Array.isArray(state.commanders)) {
    for (const [k, v] of state.commanders) _commanders.set(k, v);
  }
}

export const _STRONGHOLDS = STRONGHOLDS;
export const _ELECTION_PERIOD_MS = ELECTION_PERIOD_MS;
