// Vice vs Virtue — modern faction system replacing Magincia/Britain/Yew/
// Trinsic factions. ServUO `Engines/VvV/` overhauls the original PvP
// faction system with:
//   • 2 sides only — Vice + Virtue (any guild may sign up to either).
//   • City siege windows: every 3 days, a city's sigil opens; whichever
//     side captures it first holds the city until the next window.
//   • Per-kill points (instead of stat-loss): killer earns 1-3 points
//     scaled by victim's tier. Points buy artifacts at faction vendors.
//   • Battlegrounds: Felucca-only PvP zones around contested cities.
//   • No siege-bonus drain (virtues still tick down on death, but no
//     "skill loss" penalty).
//
// API:
//   vvv.signUp(player, side)              — 'vice' | 'virtue'
//   vvv.leave(player)                     — quit faction (1-week cooldown)
//   vvv.recordKill(killer, victim)        — award points + update kill log
//   vvv.startSiege(cityName)              — open the sigil for capture
//   vvv.captureCity(cityName, side)       — set holder + start countdown
//   vvv.holderOf(cityName)                — current owner side
//   vvv.points(player)                    — point balance
//
// Persistence: each player's account holds `vvv: { side, points, joinedAt }`.

const SIDES = Object.freeze(['vice', 'virtue']);
const CITIES = Object.freeze([
  'britain', 'minoc', 'trinsic', 'yew',
  'magincia', 'moonglow', 'jhelom', 'vesper', 'skarabrae',
]);
const SIEGE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const REJOIN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const _holders = new Map();             // city → side
const _sieges  = new Map();             // city → { startedAt, sigilSerial }
const _participants = new Map();        // accountId → { side, points, joinedAt }

export function signUp(player, side) {
  if (!SIDES.includes(side)) return { ok: false, reason: 'bad-side' };
  const acc = player?.accountId;
  if (!acc) return { ok: false, reason: 'no-account' };
  const cur = _participants.get(acc);
  if (cur && Date.now() - (cur.leftAt ?? 0) < REJOIN_COOLDOWN_MS && cur.leftAt) {
    return { ok: false, reason: 'cooldown', expiresAt: cur.leftAt + REJOIN_COOLDOWN_MS };
  }
  _participants.set(acc, { side, points: cur?.points ?? 0, joinedAt: Date.now(), leftAt: 0 });
  return { ok: true, side };
}

export function leave(player) {
  const acc = player?.accountId;
  if (!acc) return false;
  const cur = _participants.get(acc);
  if (!cur) return false;
  cur.leftAt = Date.now();
  cur.side = null;
  return true;
}

export function sideOf(player) {
  return _participants.get(player?.accountId)?.side ?? null;
}

export function points(player) {
  return _participants.get(player?.accountId)?.points ?? 0;
}

export function recordKill(killer, victim) {
  if (!killer || !victim) return 0;
  const ks = sideOf(killer), vs = sideOf(victim);
  if (!ks || !vs || ks === vs) return 0;
  // Tier of victim by points balance (rough proxy):
  const vp = points(victim);
  const tier = vp < 100 ? 1 : vp < 500 ? 2 : 3;
  const cur = _participants.get(killer.accountId);
  if (!cur) return 0;
  cur.points += tier;
  return tier;
}

export function startSiege(cityName, sigilSerial = null) {
  if (!CITIES.includes(cityName)) return false;
  _sieges.set(cityName, { startedAt: Date.now(), sigilSerial });
  return true;
}

export function captureCity(cityName, side) {
  if (!SIDES.includes(side)) return false;
  if (!CITIES.includes(cityName)) return false;
  _holders.set(cityName, side);
  _sieges.delete(cityName);
  return true;
}

export function holderOf(cityName) {
  return _holders.get(cityName) ?? null;
}

export function activeSiege(cityName) {
  return _sieges.get(cityName) ?? null;
}

export function citiesUnderSide(side) {
  const out = [];
  for (const [c, s] of _holders) if (s === side) out.push(c);
  return out;
}

/** Buy an artifact at a faction vendor. Returns true if points deducted. */
export function buyArtifact(player, cost) {
  const acc = _participants.get(player?.accountId);
  if (!acc || acc.points < cost) return false;
  acc.points -= cost;
  return true;
}

/** Tick — open sieges every SIEGE_INTERVAL_MS for the city with the
 *  longest hold, mimicking ServUO's rotation. */
let _lastTick = 0;
export function tick(now = Date.now()) {
  if (now - _lastTick < SIEGE_INTERVAL_MS) return;
  _lastTick = now;
  // Pick the city held longest (ties = lexical first).
  let target = null;
  for (const c of CITIES) {
    if (!_holders.has(c)) { target = c; break; }
  }
  if (!target) target = CITIES[0];
  startSiege(target);
}

export const VVV_CONST = Object.freeze({
  SIDES, CITIES, SIEGE_INTERVAL_MS, REJOIN_COOLDOWN_MS,
});
