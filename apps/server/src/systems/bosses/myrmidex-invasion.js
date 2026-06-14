// Myrmidex Invasion — port of ServUO
// `Scripts/Services/Myrmidex Invasion/`. Eodon-tribal world event:
// myrmidex insectoids spawn in waves at four key tiles, each tile
// captured by either side (Tribesmen / Myrmidex) tilts the points
// score. Whoever holds 3-of-4 by phase end wins the event reward.
//
// We keep a minimal state machine with three phases: PREP, ACTIVE,
// CLEANUP. Caller (a once-per-day event scheduler) drives phase
// transitions. Capture point ownership is a tally of players +
// myrmidex spawns in proximity.

const PHASE_DURATION = {
  prep: 5 * 60 * 1000,
  active: 30 * 60 * 1000,
  cleanup: 5 * 60 * 1000,
};
const POINTS = ['plateau', 'temple', 'gateway', 'amphitheater'];

let _state = null;

export function startEvent(now = Date.now()) {
  _state = {
    startedAt: now,
    phase: 'prep',
    nextPhaseAt: now + PHASE_DURATION.prep,
    captures: Object.fromEntries(POINTS.map((p) => [p, { tribe: 0, myrm: 0, owner: null }])),
    score: { tribe: 0, myrm: 0 },
    winner: null,
  };
  return _state;
}

export function tick(now = Date.now()) {
  if (!_state) return null;
  if (now >= _state.nextPhaseAt) {
    if (_state.phase === 'prep')        { _state.phase = 'active'; _state.nextPhaseAt = now + PHASE_DURATION.active; }
    else if (_state.phase === 'active') { _state.phase = 'cleanup'; _state.nextPhaseAt = now + PHASE_DURATION.cleanup; settle(); }
    else if (_state.phase === 'cleanup'){ _state = null; return null; }
  }
  return _state;
}

export function tallyCapture(point, kind) {
  if (!_state) return;
  const cap = _state.captures[point]; if (!cap) return;
  if (kind === 'tribe' || kind === 'myrm') cap[kind] += 1;
  cap.owner = cap.tribe > cap.myrm ? 'tribe' : (cap.myrm > cap.tribe ? 'myrm' : null);
}

function settle() {
  if (!_state) return;
  let tribeWins = 0, myrmWins = 0;
  for (const p of POINTS) {
    const o = _state.captures[p].owner;
    if (o === 'tribe') tribeWins++;
    else if (o === 'myrm') myrmWins++;
  }
  _state.score = { tribe: tribeWins, myrm: myrmWins };
  _state.winner = tribeWins > myrmWins ? 'tribe' : (myrmWins > tribeWins ? 'myrm' : 'draw');
}

export function snapshot() { return _state ? { ..._state } : null; }
export function isActive() { return _state?.phase === 'active'; }
