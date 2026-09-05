// PHASE BY — Faction system (Felucca PvP).
//
// ServUO reference: Scripts/Engines/Factions/. The full faction stack
// (sigils, towns, town-buy menus, ranking ladders) is gigantic; this
// module ships the irreducible core:
//   - 4 named factions matching the canonical UO set
//   - per-mobile membership (string key)
//   - kill counter ratchet (faction kill = killing an opposing faction
//     player while you're flagged)
//   - rank tier derived from kill count
//
// `notoriety.viewerNotoriety` already consults `mob.faction`; PHASE BY
// only had to add the same-faction Ally branch (bugfix #41).

/** Canonical UO factions and their banner hues. */
export const FACTIONS = Object.freeze({
  'council':    { name: 'Council of Mages', hue: 0x00B7 },
  'minax':      { name: 'Minax',            hue: 0x0026 },
  'shadowlords':{ name: 'Shadowlords',      hue: 0x0455 },
  'truebrits':  { name: 'True Britannians', hue: 0x0058 },
});

const RANK_THRESHOLDS = [
  { rank: 1, name: 'Apprentice', kills: 0 },
  { rank: 2, name: 'Squire',     kills: 5 },
  { rank: 3, name: 'Knight',     kills: 25 },
  { rank: 4, name: 'Captain',    kills: 75 },
  { rank: 5, name: 'Commander',  kills: 200 },
];

/**
 * Join `mob` to `factionKey`. Validates the key against `FACTIONS`.
 * Idempotent — returns true if the membership actually changed.
 *
 * @param {*} mob
 * @param {string} factionKey
 * @returns {boolean}
 */
export function joinFaction(mob, factionKey) {
  if (!mob) return false;
  if (!FACTIONS[factionKey]) return false;
  if (mob.faction === factionKey) return false;
  // BH #14 A2 — leave the previous faction first + reset kill tally.
  // Was silently carrying over factionKills, letting players faction-
  // hop with instant rank promotion.
  if (mob.faction) {
    mob.faction = null;
    mob.factionKills = 0;
  }
  mob.faction = factionKey;
  mob.factionKills = 0;
  return true;
}

/**
 * Drop the mobile's faction membership. Optional `reset` zeroes the
 * kill counter too (used when joining a new faction after a wash-out
 * waiting period; canonical UO requires 7 days idle but we don't
 * gate that here).
 *
 * @param {*} mob
 * @param {{reset?:boolean}} [opts]
 */
export function leaveFaction(mob, opts = {}) {
  if (!mob) return false;
  if (!mob.faction) return false;
  delete mob.faction;
  if (opts.reset) mob.factionKills = 0;
  return true;
}

/**
 * Record a faction kill on `killer` if both sides are factioned and
 * opposing. Mirrors `recordKill` from notoriety.js but in a separate
 * tally so faction PvP doesn't pump the murder count (which would
 * also turn the killer red to non-faction observers).
 *
 * @param {*} killer
 * @param {*} victim
 * @returns {boolean}  true when a kill was credited
 */
export function recordFactionKill(killer, victim) {
  if (!killer?.faction || !victim?.faction) return false;
  if (killer.faction === victim.faction) return false;
  if (killer === victim) return false;
  killer.factionKills = (killer.factionKills | 0) + 1;
  return true;
}

/**
 * Resolve `mob`'s rank based on `factionKills`. Returns the highest
 * tier whose threshold is met. Always returns at least Apprentice.
 *
 * @param {*} mob
 * @returns {{rank:number, name:string, kills:number}}
 */
export function rankOf(mob) {
  const kills = mob?.factionKills | 0;
  let best = RANK_THRESHOLDS[0];
  for (const t of RANK_THRESHOLDS) {
    if (kills >= t.kills) best = t;
  }
  return best;
}

export const _RANK_THRESHOLDS = RANK_THRESHOLDS;

// Same-faction guard / NPC roster helpers — content scripts use these
// to populate strongholds with appropriate spawns.

export const FACTION_NPC_ROSTER = Object.freeze({
  council:    ['council-mage',  'council-guardian', 'council-warden'],
  minax:      ['minax-cultist', 'minax-warlord',    'minax-warden'],
  shadowlords:['shadow-knight', 'shadow-archer',    'shadow-warden'],
  truebrits:  ['britannian-paladin', 'britannian-archer', 'britannian-warden'],
});

/**
 * Mark a freshly-spawned NPC with a faction tag. Caller supplies the
 * faction key — content scripts call this when spawning NPCs into a
 * stronghold rect.
 */
export function tagFactionNpc(mob, factionKey) {
  if (!mob || !FACTIONS[factionKey]) return false;
  mob.faction = factionKey;
  return true;
}

// =====================================================================
// Election & Finance — ServUO `Faction/Core/Election.cs` +
// `Faction/Core/Finance.cs`.
//
// Each faction has a Commander seat (4-week term). Members nominate
// candidates (must have ≥ 10 kills); after 1 week the candidate list
// closes and a 1-week ballot opens. Each member casts one vote. After
// the vote closes the candidate with most votes becomes Commander.
//
// Finance — the Commander controls a treasury (gold + silver pool)
// fed by stronghold capture rents. `withdraw` spends silver on
// faction-wide buffs; `payToVendor` covers stronghold guard wages.
// =====================================================================

const ELECTION_PHASE_MS = 7 * 24 * 60 * 60 * 1000;     // 1 week per phase
const NOMINATE_MIN_KILLS = 10;

/** @type {Map<string, FactionElection>} */
const _elections = new Map();
/** @type {Map<string, FactionFinance>} */
const _finance = new Map();

function _ensureElection(factionKey, now = Date.now()) {
  if (!FACTIONS[factionKey]) return null;
  let e = _elections.get(factionKey);
  if (!e) {
    e = {
      phase: 'idle',
      phaseStart: now,
      candidates: new Set(),
      voters: new Set(),                                 // voter serials that have cast
      tally: new Map(),                                  // candidateSerial → count
      commanderSerial: 0,
      // Force the very first tick to roll over into nominate.
      // ServUO seeds the election four weeks ago at server boot so
      // the first election cycle starts roughly at midnight.
      termStart: now - 5 * ELECTION_PHASE_MS,
    };
    _elections.set(factionKey, e);
  }
  return e;
}

function _ensureFinance(factionKey) {
  if (!FACTIONS[factionKey]) return null;
  let f = _finance.get(factionKey);
  if (!f) {
    f = { gold: 0, silver: 0, log: [] };
    _finance.set(factionKey, f);
  }
  return f;
}

/** Move the election phase forward if its window has elapsed. Caller
 *  invokes this from the main loop (cheap — only checks the timer). */
export function tickElection(factionKey, now = Date.now()) {
  const e = _ensureElection(factionKey, now);
  if (!e) return null;
  // Idle → nominate transition is gated on the term clock, NOT on
  // the phaseStart window (idle phaseStart resets on each cycle).
  if (e.phase === 'idle' && now - e.termStart > 4 * ELECTION_PHASE_MS) {
    e.phase = 'nominate';
    e.phaseStart = now;
    return e;
  }
  if (now - e.phaseStart < ELECTION_PHASE_MS) return e;
  if (e.phase === 'nominate') {
    if (e.candidates.size === 0) {
      // No candidates — restart nominate phase.
      e.phaseStart = now;
      return e;
    }
    e.phase = 'ballot';
    e.phaseStart = now;
    e.voters.clear();
    e.tally.clear();
    return e;
  }
  if (e.phase === 'ballot') {
    // Tally — pick highest-vote candidate.
    let best = 0; let bestVotes = -1;
    for (const [serial, count] of e.tally) {
      if (count > bestVotes) { bestVotes = count; best = serial; }
    }
    e.commanderSerial = best;
    e.termStart = now;
    e.phase = 'idle';
    e.phaseStart = now;
    e.candidates.clear();
    e.voters.clear();
    e.tally.clear();
    return e;
  }
  return e;
}

/** Nominate `mob` as Commander candidate. Returns { ok, reason }. */
export function nominateCandidate(factionKey, mob) {
  const e = _ensureElection(factionKey);
  if (!e) return { ok: false, reason: 'no-faction' };
  if (mob?.faction !== factionKey) return { ok: false, reason: 'not-member' };
  if (e.phase !== 'nominate') return { ok: false, reason: 'wrong-phase' };
  if ((mob.factionKills ?? 0) < NOMINATE_MIN_KILLS) return { ok: false, reason: 'low-kills' };
  e.candidates.add(mob.serial >>> 0);
  return { ok: true };
}

/** Cast a ballot. Each member can vote once per election. */
export function castVote(factionKey, voter, candidateSerial) {
  const e = _ensureElection(factionKey);
  if (!e) return { ok: false, reason: 'no-faction' };
  if (voter?.faction !== factionKey) return { ok: false, reason: 'not-member' };
  if (e.phase !== 'ballot') return { ok: false, reason: 'wrong-phase' };
  if (!e.candidates.has(candidateSerial >>> 0)) return { ok: false, reason: 'not-candidate' };
  const voterKey = voter.serial >>> 0;
  if (e.voters.has(voterKey)) return { ok: false, reason: 'already-voted' };
  e.voters.add(voterKey);
  const cur = e.tally.get(candidateSerial >>> 0) ?? 0;
  e.tally.set(candidateSerial >>> 0, cur + 1);
  return { ok: true };
}

export function electionState(factionKey) {
  const e = _elections.get(factionKey);
  if (!e) return null;
  return {
    phase: e.phase,
    candidates: [...e.candidates],
    commanderSerial: e.commanderSerial,
    phaseEndsAt: e.phaseStart + ELECTION_PHASE_MS,
  };
}

/** Treasury — deposit gold from stronghold rent / capture rewards. */
export function depositFactionGold(factionKey, amount) {
  const f = _ensureFinance(factionKey);
  if (!f) return 0;
  f.gold += Math.max(0, amount | 0);
  return f.gold;
}

/** Withdraw gold; only the elected Commander may call. */
export function withdrawFactionGold(factionKey, requester, amount) {
  const f = _ensureFinance(factionKey);
  const e = _ensureElection(factionKey);
  if (!f || !e) return { ok: false, reason: 'no-faction' };
  if ((requester?.serial >>> 0) !== e.commanderSerial) return { ok: false, reason: 'not-commander' };
  if (f.gold < amount) return { ok: false, reason: 'insufficient' };
  f.gold -= amount;
  f.log.push({ ts: Date.now(), action: 'withdraw', amount, by: requester.serial });
  return { ok: true, remaining: f.gold };
}

export function financeState(factionKey) {
  const f = _finance.get(factionKey);
  if (!f) return null;
  return { gold: f.gold, silver: f.silver, log: f.log.slice(-10) };
}

/** Test helper. */
export function _resetFactionPolitics() {
  _elections.clear();
  _finance.clear();
}
