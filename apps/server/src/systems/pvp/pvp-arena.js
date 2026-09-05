// PVP Arena — port of ServUO `Scripts/Services/PVP Arena System/`.
// Structured duel + 1v1 / 2v2 queue with bracket logic. Mirrors the
// ServUO arena registration + match start + score tracking.
//
// Wire (chat-driven for MVP):
//   [arena queue 1v1            → enrol the sender in the 1v1 queue
//   [arena queue 2v2            → enrol the sender + party in 2v2 queue
//   [arena leave                → drop out of all queues
//   [arena status               → list current queues + the player's match
//   [arena t create <name>      → start a single-elimination tournament
//   [arena t join <name>        → join an open tournament
//   [arena t start <name>       → close registration + bracket the players
//   [arena t status             → list active tournaments + current round
//
// Match lifecycle:
//   1. `tickPairing(world)` pulls pairs off the queues and calls
//      `startMatch` which teleports the combatants to opposite arena
//      tiles, saves pre-match coords, heals to full.
//   2. While the match runs, `canArenaAttack(a, b)` returns true so
//      combat.damage bypasses friendly-fire / criminal gates between
//      the two sides. `flagCriminal` is suppressed in-match. Match
//      participants can ONLY damage their declared opponents (no
//      stray harm to spectators).
//   3. `tickMatches(now)` checks for win/timeout. On end the survivors
//      are healed, teleported back to their pre-match coords, and the
//      loser is auto-resurrected on-site (no real corpse drop).
//   4. Tournament mode: `recordTournamentWin` advances the bracket;
//      when only one player remains, `awardTournamentWinner` fires.

const ARENA_MAP = 1;
// Canonical arena coords — Jhelom Pits (PvP center of T2A Brit). Two
// spawn pads ~6 tiles apart so both fighters have approach time.
const ARENA_CENTER_X = 1407;
const ARENA_CENTER_Y = 3837;
const ARENA_CENTER_Z = 9;
const ARENA_SPAWNS_1V1 = [
  { x: 1404, y: 3837, z: 9 },          // West pad
  { x: 1410, y: 3837, z: 9 },          // East pad
];
const ARENA_SPAWNS_2V2 = [
  { x: 1403, y: 3835, z: 9 }, { x: 1403, y: 3839, z: 9 },   // Team A
  { x: 1411, y: 3835, z: 9 }, { x: 1411, y: 3839, z: 9 },   // Team B
];

const MATCH_TIMEOUT_MS = 5 * 60 * 1000;
const TOURNEY_TIMEOUT_MS = 60 * 60 * 1000;

const _queue1v1 = [];                       // serial[]
const _queue2v2 = [];                       // partyId[]
/** @type {Map<number, {id, mode, teamA, teamB, startedAt, ended, winner, endedAt, tournamentId?}>} */
const _matches  = new Map();
let _nextMatch = 1;
/** @type {Map<number, {x, y, z, map}>} */
const _preMatchPos = new Map();             // serial → pos before teleport
/** @type {Map<string, Tournament>} */
const _tournaments = new Map();
let _nextTournament = 1;

class Tournament {
  constructor(name, creatorSerial) {
    this.id = _nextTournament++;
    this.name = name;
    this.creatorSerial = creatorSerial;
    this.entrants = [];                     // serial[]
    this.bracket = null;                    // [[s1,s2], [s3,s4], …]
    this.round = 0;
    this.activeMatchIds = new Set();
    this.winners = [];
    this.champion = null;                   // serial
    this.startedAt = null;
    this.createdAt = Date.now();
  }
}

/* ──────────────── Queues ──────────────── */

export function enrol1v1(mob) {
  if (!mob) return false;
  if (isInMatch(mob)) return false;
  if (_queue1v1.includes(mob.serial)) return false;
  _queue1v1.push(mob.serial);
  return true;
}

export function enrol2v2(party) {
  if (!party?.id) return false;
  if (_queue2v2.includes(party.id)) return false;
  if (party._arenaMatchId) return false;
  _queue2v2.push(party.id);
  return true;
}

export function leave(mob) {
  if (!mob) return false;
  const i1 = _queue1v1.indexOf(mob.serial);
  if (i1 >= 0) _queue1v1.splice(i1, 1);
  return i1 >= 0;
}

export function leaveParty(party) {
  if (!party?.id) return false;
  const i = _queue2v2.indexOf(party.id);
  if (i >= 0) _queue2v2.splice(i, 1);
  return i >= 0;
}

/* ──────────────── Pair-up + match lifecycle ──────────────── */

/** Walk both queues and start matches for ready pairs. Called from the
 *  arena tick interval set up by `init()`. */
export function tickPairing(world) {
  const out = [];
  while (_queue1v1.length >= 2) {
    const aS = _queue1v1.shift();
    const bS = _queue1v1.shift();
    const a = world?.mobiles?.get?.(aS);
    const b = world?.mobiles?.get?.(bS);
    if (!a || !b) continue;
    const m = _startMatchInternal(world, '1v1', [a], [b]);
    if (m) out.push(m);
  }
  // 2v2 — pair queued parties. Skip if `api.party` not set.
  while (_queue2v2.length >= 2 && world?._partyRegistry?.byId) {
    const aId = _queue2v2.shift();
    const bId = _queue2v2.shift();
    const pa = world._partyRegistry.byId.get(aId);
    const pb = world._partyRegistry.byId.get(bId);
    if (!pa || !pb) continue;
    const teamA = (pa.members ?? []).slice(0, 2)
      .map((serial) => world.mobiles.get(serial)).filter(Boolean);
    const teamB = (pb.members ?? []).slice(0, 2)
      .map((serial) => world.mobiles.get(serial)).filter(Boolean);
    if (teamA.length < 1 || teamB.length < 1) continue;
    const m = _startMatchInternal(world, '2v2', teamA, teamB);
    if (m) out.push(m);
  }
  return out;
}

function _startMatchInternal(world, mode, teamA, teamB) {
  const spawns = mode === '2v2' ? ARENA_SPAWNS_2V2 : ARENA_SPAWNS_1V1;
  const id = _nextMatch++;
  const match = {
    id, mode,
    teamA: teamA.map((m) => m.serial),
    teamB: teamB.map((m) => m.serial),
    startedAt: Date.now(),
    ended: false,
    winner: null,
    endedAt: 0,
  };
  _matches.set(id, match);
  // Teleport + heal each fighter. ServUO `DuelContext.SendBeginGump`
  // freezes them for 10 s; we just heal+stand them up.
  const order = [...teamA.map((m) => ({ m, spawn: spawns[0] })),
                 ...teamB.map((m, i) => ({ m, spawn: spawns[Math.min(mode === '2v2' ? i + 2 : 1, spawns.length - 1)] }))];
  // 2v2: two-per-side
  if (mode === '2v2') {
    order.length = 0;
    order.push({ m: teamA[0], spawn: spawns[0] });
    if (teamA[1]) order.push({ m: teamA[1], spawn: spawns[1] });
    order.push({ m: teamB[0], spawn: spawns[2] });
    if (teamB[1]) order.push({ m: teamB[1], spawn: spawns[3] });
  }
  for (const { m, spawn } of order) {
    if (!m) continue;
    _preMatchPos.set(m.serial, { x: m.x, y: m.y, z: m.z, map: m.map ?? ARENA_MAP });
    m._arenaMatchId = id;
    _teleport(world, m, spawn.x, spawn.y, spawn.z, ARENA_MAP);
    // Heal to full so the match starts on even footing.
    m.hp = m.hpMax ?? m.hp ?? 100;
    m.mana = m.manaMax ?? m.mana ?? 50;
    m.stam = m.stamMax ?? m.stam ?? 50;
    if (m.client) {
      try { m.client.sendSystemMessage?.(`Arena match begins — defeat the other team!`); }
      catch { /* advisory */ }
    }
  }
  return match;
}

/** Canonical in-engine teleport. Mirrors the pattern used by Magery's
 *  Teleport / Sacred Journey: mutate the mob's coords, then re-bucket
 *  the sector index so AI / visibility queries see the new tile. */
function _teleport(world, mob, x, y, z, map) {
  if (!mob) return;
  mob.x = x | 0;
  mob.y = y | 0;
  mob.z = z | 0;
  if (map != null) mob.map = map | 0;
  try { world?.sectors?.moveMobile?.(mob); }
  catch { /* sectors optional in test harness */ }
}

/** Direct match starter — used by tournaments to bracket explicit pairs
 *  without going through the queue. */
export function startMatch(world, mode, teamA, teamB, tournamentId = null) {
  const match = _startMatchInternal(world, mode, teamA, teamB);
  if (match && tournamentId != null) match.tournamentId = tournamentId;
  return match;
}

/* ──────────────── Damage / kill / criminal-flag gates ──────────────── */

/** Combat gate: TRUE iff both mobs are in the same active match on
 *  opposing teams. Outside of a match the regular notoriety / guard
 *  system rules apply. */
export function canArenaAttack(a, b) {
  if (!a || !b) return false;
  for (const m of _matches.values()) {
    if (m.ended) continue;
    const aA = m.teamA.includes(a.serial), aB = m.teamB.includes(a.serial);
    const bA = m.teamA.includes(b.serial), bB = m.teamB.includes(b.serial);
    if ((aA && bB) || (aB && bA)) return true;
  }
  return false;
}

/** Suppress the criminal flag when the source/target relationship is
 *  inside the same arena match. Called from notoriety.flagCriminal as
 *  a pre-check (wired in init). */
export function isArenaCombat(attacker, victim) {
  return canArenaAttack(attacker, victim);
}

/** Process a kill — strip the dead mob from its team, end the match if
 *  one side is empty, restore positions. Returns the affected match or
 *  null. Wired to corpse.addKillHook in init(). */
export function recordKill(world, killer, victim) {
  if (!victim?.serial) return null;
  let touched = null;
  for (const m of _matches.values()) {
    if (m.ended) continue;
    const inA = m.teamA.includes(victim.serial);
    const inB = m.teamB.includes(victim.serial);
    if (!inA && !inB) continue;
    if (inA) m.teamA = m.teamA.filter((s) => s !== victim.serial);
    if (inB) m.teamB = m.teamB.filter((s) => s !== victim.serial);
    // Auto-res the loser on the spot — arena death isn't a real death.
    _resurrectInArena(world, victim);
    if (m.teamA.length === 0 || m.teamB.length === 0) {
      _endMatch(world, m, m.teamA.length === 0 ? 'B' : 'A', 'kill');
    }
    touched = m;
    break;
  }
  void killer;
  return touched;
}

function _resurrectInArena(world, mob) {
  if (!mob) return;
  mob.ghost = false;
  mob.hp = Math.max(1, Math.floor((mob.hpMax ?? 50) * 0.4));
  mob.mana = Math.max(1, Math.floor((mob.manaMax ?? 50) * 0.4));
  mob.stam = Math.max(1, Math.floor((mob.stamMax ?? 50) * 0.4));
  mob.body = mob._origBody ?? mob.body;
  // Bring them back to the centre tile so the surviving side doesn't
  // get to teabag the corpse.
  _teleport(world, mob, ARENA_CENTER_X, ARENA_CENTER_Y, ARENA_CENTER_Z, ARENA_MAP);
}

/** Timeout sweep — call from interval. Any match older than
 *  MATCH_TIMEOUT_MS ends in a draw (or whichever side has more alive). */
export function tickMatches(world, now = Date.now()) {
  for (const m of _matches.values()) {
    if (m.ended) continue;
    if (now - m.startedAt < MATCH_TIMEOUT_MS) continue;
    // Timeout — count remaining members. Tie → draw.
    let winner = 'draw';
    if (m.teamA.length > m.teamB.length) winner = 'A';
    else if (m.teamB.length > m.teamA.length) winner = 'B';
    _endMatch(world, m, winner, 'timeout');
  }
}

function _endMatch(world, m, winner, reason) {
  m.ended = true;
  m.winner = winner;
  m.endedAt = Date.now();
  // Restore everyone on both teams to their pre-match position.
  const allSerials = [...m.teamA, ...m.teamB];
  // Pull in the dead — they were removed from teamX but we still
  // need to restore their position. The _preMatchPos map holds them.
  for (const [s, pos] of _preMatchPos.entries()) {
    const mob = world?.mobiles?.get?.(s);
    if (!mob || mob._arenaMatchId !== m.id) continue;
    mob._arenaMatchId = null;
    _teleport(world, mob, pos.x, pos.y, pos.z, pos.map);
    mob.hp = mob.hpMax ?? mob.hp ?? 100;
    mob.mana = mob.manaMax ?? mob.mana ?? 50;
    mob.stam = mob.stamMax ?? mob.stam ?? 50;
    _preMatchPos.delete(s);
    if (mob.client) {
      const won = (winner === 'A' && m.teamA.includes(s))
               || (winner === 'B' && m.teamB.includes(s));
      const text = winner === 'draw'
        ? `Arena match ended in a draw (${reason}).`
        : won
          ? `You won the arena match!`
          : `You lost the arena match (${reason}).`;
      try { mob.client.sendSystemMessage?.(text); } catch { /* advisory */ }
    }
  }
  void allSerials;
  // Tournament advancement.
  if (m.tournamentId != null) {
    const t = [..._tournaments.values()].find((x) => x.id === m.tournamentId);
    if (t) _advanceTournament(world, t, m);
  }
}

/* ──────────────── Tournaments ──────────────── */

/** Create a new tournament. Open for registration until `start` is
 *  called by the creator (or another GM). */
export function tournamentCreate(name, creator) {
  const key = name.toLowerCase();
  if (_tournaments.has(key)) return null;
  const t = new Tournament(name, creator?.serial ?? 0);
  _tournaments.set(key, t);
  return t;
}

export function tournamentJoin(name, mob) {
  const t = _tournaments.get(name.toLowerCase());
  if (!t) return { ok: false, reason: 'no-tournament' };
  if (t.startedAt) return { ok: false, reason: 'already-started' };
  if (t.entrants.includes(mob.serial)) return { ok: false, reason: 'already-joined' };
  t.entrants.push(mob.serial);
  return { ok: true, tournament: t };
}

export function tournamentStart(world, name) {
  const t = _tournaments.get(name.toLowerCase());
  if (!t) return { ok: false, reason: 'no-tournament' };
  if (t.startedAt) return { ok: false, reason: 'already-started' };
  if (t.entrants.length < 2) return { ok: false, reason: 'not-enough-entrants' };
  t.startedAt = Date.now();
  // Pad to next power of two with byes.
  const next2 = 1 << Math.ceil(Math.log2(t.entrants.length));
  const padded = [...t.entrants];
  while (padded.length < next2) padded.push(null); // bye
  // Shuffle so the bracket isn't deterministic.
  for (let i = padded.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [padded[i], padded[j]] = [padded[j], padded[i]];
  }
  t.bracket = [];
  for (let i = 0; i < padded.length; i += 2) {
    t.bracket.push([padded[i], padded[i + 1]]);
  }
  t.round = 1;
  _startTournamentRound(world, t);
  return { ok: true, tournament: t };
}

function _startTournamentRound(world, t) {
  t.activeMatchIds.clear();
  for (const pair of t.bracket) {
    const [aS, bS] = pair;
    // Bye — auto-advance the present player.
    if (aS == null && bS == null) { t.winners.push(null); continue; }
    if (aS == null) { t.winners.push(bS); continue; }
    if (bS == null) { t.winners.push(aS); continue; }
    const a = world?.mobiles?.get?.(aS);
    const b = world?.mobiles?.get?.(bS);
    if (!a || !b) {
      // Player offline — opponent advances.
      t.winners.push(a ? aS : bS);
      continue;
    }
    const m = startMatch(world, '1v1', [a], [b], t.id);
    if (m) t.activeMatchIds.add(m.id);
  }
}

function _advanceTournament(world, t, finishedMatch) {
  t.activeMatchIds.delete(finishedMatch.id);
  const winSerial = finishedMatch.winner === 'A' ? finishedMatch.teamA[0]
                  : finishedMatch.winner === 'B' ? finishedMatch.teamB[0]
                  : null;
  // teamA/teamB are wiped on end — fall back to bracket pair.
  const pair = t.bracket.find((p) =>
    (p[0] === finishedMatch.teamA[0] && p[1] === finishedMatch.teamB[0]) ||
    (p[1] === finishedMatch.teamA[0] && p[0] === finishedMatch.teamB[0]) ||
    p.includes(finishedMatch.teamA[0]) || p.includes(finishedMatch.teamB[0]));
  if (!pair) return;
  const fallback = winSerial ?? pair[0];     // draw → first slot wins
  t.winners.push(fallback);
  if (t.activeMatchIds.size === 0) {
    if (t.winners.length === 1) {
      t.champion = t.winners[0];
      _awardTournamentWinner(world, t);
      return;
    }
    // Next round.
    const nextSeed = t.winners.filter((s) => s != null);
    t.bracket = [];
    for (let i = 0; i < nextSeed.length; i += 2) {
      t.bracket.push([nextSeed[i], nextSeed[i + 1] ?? null]);
    }
    t.winners = [];
    t.round++;
    _startTournamentRound(world, t);
  }
}

function _awardTournamentWinner(world, t) {
  const champ = world?.mobiles?.get?.(t.champion);
  if (!champ?.client) return;
  champ.client.sendSystemMessage?.(`★ You won the "${t.name}" tournament! ★`);
  // Award a trophy (item 0x4C8C "Cup") in the champion's pack.
  if (world?._itemsApi?.createItem) {
    try {
      const pack = [...world.items.values()].find?.((it) =>
        it.parent === champ.serial && it.layer === 21);
      if (pack) {
        world._itemsApi.createItem(world, {
          itemId: 0x4C8C, hue: 0x501,
          name: `${t.name} Champion's Cup`,
          parent: pack.serial,
          x: 60, y: 60, z: 0, map: champ.map ?? ARENA_MAP,
          movable: true,
        });
      }
    } catch { /* trophy is advisory */ }
  }
}

/* ──────────────── Read-only API ──────────────── */

export function status() {
  return {
    queue1v1: [..._queue1v1],
    queue2v2: [..._queue2v2],
    matches: Array.from(_matches.values()).filter((m) => !m.ended),
    tournaments: Array.from(_tournaments.values()).map((t) => ({
      name: t.name, entrants: t.entrants.length,
      round: t.round, started: !!t.startedAt, champion: t.champion,
    })),
  };
}

export function isInMatch(mob) {
  if (!mob) return false;
  for (const m of _matches.values()) {
    if (m.ended) continue;
    if (m.teamA.includes(mob.serial)) return true;
    if (m.teamB.includes(mob.serial)) return true;
  }
  return false;
}

/* ──────────────── Boot wiring ──────────────── */

let _interval = null;
let _killHookInstalled = false;

/** Wire the arena into the shard:
 *   • kill-hook → recordKill
 *   • setInterval → tickPairing + tickMatches (every 2 s)
 *   • exposes `_partyRegistry` on world so tickPairing can resolve 2v2
 *     party IDs without crossing the script boundary.
 *
 *  Idempotent — re-calling does nothing extra (safe across hot-reload). */
export function init({ world, corpse, partyRegistry, itemsApi, scheduler } = {}) {
  if (world) {
    if (partyRegistry) world._partyRegistry = partyRegistry;
    if (itemsApi)     world._itemsApi = itemsApi;
  }
  if (corpse?.addKillHook && !_killHookInstalled) {
    corpse.addKillHook((w, victim, killer) => {
      try { recordKill(w, killer, victim); }
      catch (e) { console.error('[arena] kill-hook threw:', e); }
    });
    _killHookInstalled = true;
  }
  if (!_interval && world) {
    const tick = () => {
      try { tickPairing(world); } catch (e) { console.error('[arena] tickPairing', e); }
      try { tickMatches(world); } catch (e) { console.error('[arena] tickMatches', e); }
      // Tournament timeout — abort stale tournaments.
      const cutoff = Date.now() - TOURNEY_TIMEOUT_MS;
      for (const [key, t] of [..._tournaments.entries()]) {
        if (t.startedAt && t.startedAt < cutoff && t.activeMatchIds.size === 0) {
          _tournaments.delete(key);
        }
      }
    };
    _interval = scheduler?.every
      ? scheduler.every('pvp-arena', 2000, tick)
      : setInterval(tick, 2000);
    if (typeof _interval?.unref === 'function') _interval.unref();
  }
}

export function shutdown() {
  if (typeof _interval?.cancel === 'function') _interval.cancel();
  else if (_interval) clearInterval(_interval);
  _interval = null;
}

/** Test-only: reset module state so test files can run in isolation. */
export function _resetForTest() {
  _queue1v1.length = 0;
  _queue2v2.length = 0;
  _matches.clear();
  _preMatchPos.clear();
  _tournaments.clear();
  _ratings.clear();
  _nextMatch = 1;
  _nextTournament = 1;
  if (typeof _interval?.cancel === 'function') _interval.cancel();
  else if (_interval) clearInterval(_interval);
  _interval = null;
  _killHookInstalled = false;
}

// =====================================================================
// Rating & season leaderboard.
//
// ServUO's official PvP Arena (Vesper Pirates / Jhelom Pits) tracks
// player wins per season; we ship the canonical ELO formula here so a
// thin `[arena rating` / `[arena top` UI can render the leaderboard.
// `recordMatchResult` is called automatically from `_endMatch` once a
// match completes. Ratings persist on the registry side because the
// kill hook routes through here.
// =====================================================================

const ELO_DEFAULT = 1200;
const ELO_K = 32;

/** @type {Map<number, { rating:number, wins:number, losses:number, season:string }>} */
const _ratings = new Map();
let _seasonId = `S${new Date().getUTCFullYear()}-${Math.ceil((new Date().getUTCMonth() + 1) / 3)}`;

function _ensureRating(serial) {
  const s = serial >>> 0;
  let r = _ratings.get(s);
  if (!r) {
    r = { rating: ELO_DEFAULT, wins: 0, losses: 0, season: _seasonId };
    _ratings.set(s, r);
  }
  // Season rollover wipes the per-season W/L counters (rating decays
  // gently rather than resetting outright).
  if (r.season !== _seasonId) {
    r.rating = Math.round(ELO_DEFAULT + (r.rating - ELO_DEFAULT) * 0.5);
    r.wins = 0; r.losses = 0; r.season = _seasonId;
  }
  return r;
}

/** Record a duel outcome; updates both players' rating + counters. */
export function recordMatchResult(winnerSerial, loserSerial) {
  const w = _ensureRating(winnerSerial);
  const l = _ensureRating(loserSerial);
  // Standard ELO update.
  const expectW = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
  w.rating = Math.round(w.rating + ELO_K * (1 - expectW));
  l.rating = Math.round(l.rating + ELO_K * (0 - (1 - expectW)));
  w.wins++;
  l.losses++;
  return { winnerRating: w.rating, loserRating: l.rating };
}

/** Look up a player's current arena rating + record. */
export function ratingOf(serial) {
  return { ..._ensureRating(serial) };
}

/** Top-N leaderboard for the current season. */
export function leaderboard(n = 10) {
  return [..._ratings.entries()]
    .filter(([, r]) => r.season === _seasonId && (r.wins + r.losses) >= 1)
    .sort((a, b) => b[1].rating - a[1].rating)
    .slice(0, n)
    .map(([serial, r]) => ({ serial, ...r }));
}

/** GM helper — rotate to a new season, decaying everyone's rating. */
export function rotateSeason(newId) {
  _seasonId = newId ?? `S${new Date().getUTCFullYear()}-${Math.ceil((new Date().getUTCMonth() + 1) / 3)}`;
}

export function currentSeasonId() { return _seasonId; }
